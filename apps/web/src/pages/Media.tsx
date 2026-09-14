import { useMemo, useRef, useState, type DragEvent } from 'react';
import type {
  MediaAssetDto,
  MediaFolderDto,
  MediaPlaybackStatsDto,
  MediaUsageDto,
  FolderUsageDto,
} from '@signage/shared';
import { resolveDisplaySettings } from '@signage/shared';
import { DisplaySettingsControls, type DisplayValue } from '../components/DisplaySettingsControls';
import { MediaDisplayPreview } from '../components/MediaDisplayPreview';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from '../components/ui';
import { FolderPickerModal, FolderTree } from '../components/FolderTree';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { formatBytes, formatDateTime, formatDuration, timeAgo } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';

interface MediaListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: MediaAssetDto[];
}

const STATUS_TONE = {
  pending: 'yellow',
  processing: 'yellow',
  ready: 'green',
  failed: 'red',
} as const;

/** 'all' = every folder, 'root' = unfiled media, otherwise a folder id. */
type FolderView = 'all' | 'root' | string;

export function MediaPage() {
  const orgId = useOrgId();
  const [view, setView] = useState<FolderView>('all');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [orientation, setOrientation] = useState('');
  const [status, setStatus] = useState('');
  const [usedInPlaylist, setUsedInPlaylist] = useState('');
  const [sort, setSort] = useState('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Dialog state
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<MediaFolderDto | null>(null);
  const [movingFolder, setMovingFolder] = useState<MediaFolderDto | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<MediaFolderDto | null>(null);
  const [movingMedia, setMovingMedia] = useState<string[] | null>(null);
  const [deletingMedia, setDeletingMedia] = useState<MediaAssetDto[] | null>(null);
  const [detailMedia, setDetailMedia] = useState<MediaAssetDto | null>(null);

  const foldersApi = useApi(
    () => api.get<MediaFolderDto[]>(`/orgs/${orgId}/media/folders`),
    [orgId],
  );
  const folders = foldersApi.data ?? [];
  const currentFolder =
    view !== 'all' && view !== 'root' ? folders.find((f) => f.id === view) : null;

  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (type) query.set('type', type);
  if (orientation) query.set('orientation', orientation);
  if (status) query.set('status', status);
  if (usedInPlaylist) query.set('usedInPlaylist', usedInPlaylist);
  if (view !== 'all') query.set('folderId', view);
  query.set('sort', sort);
  query.set('order', order);
  query.set('page', String(page));
  query.set('pageSize', '50');

  const media = useApi(
    () => api.get<MediaListResponse>(`/orgs/${orgId}/media?${query.toString()}`),
    [orgId, search, type, orientation, status, usedInPlaylist, view, sort, order, page],
    // Poll while anything is still processing so thumbnails appear when done.
    { refreshMs: 5_000 },
  );

  const reloadAll = () => {
    media.reload();
    foldersApi.reload();
  };

  const uploadFolderId = view !== 'all' && view !== 'root' ? view : null;

  const upload = useAction(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading({ done: 0, total: list.length });
    try {
      const suffix = uploadFolderId ? `?folderId=${encodeURIComponent(uploadFolderId)}` : '';
      for (let i = 0; i < list.length; i++) {
        await api.upload(`/orgs/${orgId}/media${suffix}`, list[i]);
        setUploading({ done: i + 1, total: list.length });
      }
    } finally {
      setUploading(null);
      reloadAll();
    }
  });

  const moveMedia = useAction(async (mediaIds: string[], folderId: string | null) => {
    await api.post(`/orgs/${orgId}/media/bulk-move`, { mediaIds, folderId });
    setSelected(new Set());
    setMovingMedia(null);
    reloadAll();
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const items = media.data?.items ?? [];
  const totalPages = media.data
    ? Math.max(1, Math.ceil(media.data.total / media.data.pageSize))
    : 1;

  const breadcrumb = useMemo(() => {
    if (view === 'all') return 'All media';
    if (view === 'root') return 'Root folder';
    return currentFolder?.path ?? 'Folder';
  }, [view, currentFolder]);

  const onDropFiles = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) upload.run(e.dataTransfer.files);
  };

  return (
    <div>
      <PageHeader
        title="Media library"
        subtitle="Images and videos available for playlists"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) upload.run(e.target.files);
                e.target.value = '';
              }}
            />
            <Button variant="secondary" onClick={() => setShowCreateFolder(true)}>
              New folder
            </Button>
            <Button onClick={() => fileInput.current?.click()} disabled={uploading !== null}>
              {uploading
                ? `Uploading ${uploading.done}/${uploading.total}…`
                : view !== 'all' && view !== 'root'
                  ? 'Upload into folder'
                  : 'Upload media'}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* ------------------------------------------------ folder sidebar */}
        {/* Full width above the grid on a phone, a real sidebar from lg up:
            240px of a 375px screen is most of it. */}
        <aside className="w-full shrink-0 lg:w-60">
          <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
            {[
              { key: 'all' as const, label: 'All media', icon: '🗂' },
              { key: 'root' as const, label: 'Root folder', icon: '🏠' },
            ].map((entry) => (
              <div
                key={entry.key}
                className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
                  view === entry.key
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
                onClick={() => {
                  setView(entry.key);
                  setPage(1);
                }}
                onDragOver={(e) => {
                  if (
                    entry.key === 'root' &&
                    e.dataTransfer.types.includes('application/x-media-ids')
                  ) {
                    e.preventDefault();
                  }
                }}
                onDrop={(e) => {
                  if (entry.key !== 'root') return;
                  const raw = e.dataTransfer.getData('application/x-media-ids');
                  if (!raw) return;
                  e.preventDefault();
                  moveMedia.run(JSON.parse(raw) as string[], null);
                }}
              >
                <span aria-hidden>{entry.icon}</span> {entry.label}
              </div>
            ))}
            <div className="mt-1 border-t border-slate-100 pt-1">
              <FolderTree
                folders={folders}
                selectedId={view !== 'all' && view !== 'root' ? view : null}
                onSelect={(id) => {
                  setView(id);
                  setPage(1);
                }}
                onDropMedia={(folderId, mediaIds) => moveMedia.run(mediaIds, folderId)}
              />
              {folders.length === 0 ? (
                <p className="px-2 py-2 text-xs text-slate-400">
                  No folders yet — create one to organize media.
                </p>
              ) : null}
            </div>
          </div>
        </aside>

        {/* ----------------------------------------------------- main area */}
        <div
          className="min-w-0 flex-1"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragOver(false);
          }}
          onDrop={onDropFiles}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-700">{breadcrumb}</span>
            {currentFolder ? (
              <span className="flex gap-1">
                <Button variant="ghost" small onClick={() => setRenamingFolder(currentFolder)}>
                  Rename
                </Button>
                <Button variant="ghost" small onClick={() => setMovingFolder(currentFolder)}>
                  Move
                </Button>
                <Button variant="ghost" small onClick={() => setDeletingFolder(currentFolder)}>
                  Delete folder
                </Button>
              </span>
            ) : null}
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <div className="min-w-[12rem] grow basis-full sm:basis-64">
              <Input
                placeholder={view === 'all' ? 'Search all folders…' : 'Search in this view…'}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="min-w-[8rem] grow basis-[calc(50%-0.25rem)] sm:basis-32">
              <Select
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All types</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
              </Select>
            </div>
            <div className="min-w-[8.5rem] grow basis-[calc(50%-0.25rem)] sm:basis-36">
              <Select
                value={orientation}
                onChange={(e) => {
                  setOrientation(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Any shape</option>
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
                <option value="square">Square</option>
              </Select>
            </div>
            <div className="min-w-[8.5rem] grow basis-[calc(50%-0.25rem)] sm:basis-36">
              <Select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Any status</option>
                <option value="ready">Ready</option>
                <option value="processing">Processing</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </Select>
            </div>
            <div className="min-w-[9rem] grow basis-[calc(50%-0.25rem)] sm:basis-40">
              <Select
                value={usedInPlaylist}
                onChange={(e) => {
                  setUsedInPlaylist(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Any usage</option>
                <option value="true">In a playlist</option>
                <option value="false">Not in a playlist</option>
              </Select>
            </div>
            <div className="min-w-[10rem] grow basis-[calc(50%-0.25rem)] sm:basis-44">
              <Select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(1);
                }}
              >
                <option value="createdAt">Sort: created</option>
                <option value="updatedAt">Sort: updated</option>
                <option value="name">Sort: name</option>
                <option value="type">Sort: type</option>
                <option value="orientation">Sort: orientation</option>
                <option value="duration">Sort: duration</option>
                <option value="playCount">Sort: play count</option>
              </Select>
            </div>
            <Button
              variant="secondary"
              small
              onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
              title="Toggle sort direction"
            >
              {order === 'asc' ? '↑ asc' : '↓ desc'}
            </Button>
          </div>

          {selected.size > 0 ? (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              {selected.size} selected
              <Button small variant="secondary" onClick={() => setMovingMedia([...selected])}>
                Move to folder…
              </Button>
              <Button
                small
                variant="secondary"
                onClick={() => setDeletingMedia(items.filter((i) => selected.has(i.id)))}
              >
                Delete
              </Button>
              <Button small variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          ) : null}

          <ErrorNote message={upload.error ?? moveMedia.error ?? media.error ?? foldersApi.error} />
          {media.loading && !media.data ? <Spinner /> : null}

          {dragOver ? (
            <div className="mb-3 rounded-lg border-2 border-dashed border-blue-400 bg-blue-50 p-6 text-center text-sm text-blue-700">
              Drop files to upload into {breadcrumb}
            </div>
          ) : null}

          {media.data && items.length === 0 ? (
            <EmptyState
              title="No media found"
              hint={
                view === 'all'
                  ? 'Upload images or videos to get started.'
                  : 'This folder is empty — upload media or move files here.'
              }
            />
          ) : null}

          {items.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    showFolder={view === 'all'}
                    selected={selected.has(item.id)}
                    selectedIds={selected}
                    onToggleSelect={() => toggleSelect(item.id)}
                    onOpen={() => setDetailMedia(item)}
                    onMove={() => setMovingMedia([item.id])}
                    onDelete={() => setDeletingMedia([item])}
                    onChanged={reloadAll}
                    orgId={orgId}
                  />
                ))}
              </div>
              {totalPages > 1 ? (
                <div className="mt-4 flex items-center justify-center gap-3 text-sm text-slate-600">
                  <Button
                    variant="secondary"
                    small
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  Page {page} of {totalPages}
                  <Button
                    variant="secondary"
                    small
                    disabled={page >= totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------- dialogs */}
      {showCreateFolder ? (
        <CreateFolderModal
          orgId={orgId}
          parent={currentFolder ?? null}
          onClose={() => setShowCreateFolder(false)}
          onCreated={() => {
            setShowCreateFolder(false);
            foldersApi.reload();
          }}
        />
      ) : null}
      {renamingFolder ? (
        <RenameFolderModal
          orgId={orgId}
          folder={renamingFolder}
          onClose={() => setRenamingFolder(null)}
          onSaved={() => {
            setRenamingFolder(null);
            reloadAll();
          }}
        />
      ) : null}
      {movingFolder ? (
        <FolderPickerModal
          title={`Move "${movingFolder.name}" into…`}
          folders={folders.filter((f) => f.id !== movingFolder.id)}
          allowRoot
          confirmLabel="Move folder"
          onClose={() => setMovingFolder(null)}
          onPick={(target) => {
            const folder = movingFolder;
            setMovingFolder(null);
            void api
              .patch(`/orgs/${orgId}/media/folders/${folder.id}`, { parentFolderId: target })
              .then(reloadAll)
              .catch((err) => window.alert(err instanceof Error ? err.message : String(err)));
          }}
        />
      ) : null}
      {deletingFolder ? (
        <DeleteFolderDialog
          orgId={orgId}
          folder={deletingFolder}
          folders={folders}
          onClose={() => setDeletingFolder(null)}
          onDeleted={() => {
            setDeletingFolder(null);
            setView('all');
            reloadAll();
          }}
        />
      ) : null}
      {movingMedia ? (
        <FolderPickerModal
          title={`Move ${movingMedia.length} file(s) into…`}
          folders={folders}
          allowRoot
          confirmLabel="Move here"
          onClose={() => setMovingMedia(null)}
          onPick={(target) => moveMedia.run(movingMedia, target)}
        />
      ) : null}
      {deletingMedia ? (
        <DeleteMediaDialog
          orgId={orgId}
          media={deletingMedia}
          onClose={() => setDeletingMedia(null)}
          onDeleted={() => {
            setDeletingMedia(null);
            setSelected(new Set());
            reloadAll();
          }}
        />
      ) : null}
      {detailMedia ? (
        <MediaDetailModal orgId={orgId} media={detailMedia} onClose={() => setDetailMedia(null)} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ media card

function MediaCard({
  orgId,
  item,
  showFolder,
  selected,
  selectedIds,
  onToggleSelect,
  onOpen,
  onMove,
  onDelete,
  onChanged,
}: {
  orgId: string;
  item: MediaAssetDto;
  showFolder: boolean;
  selected: boolean;
  selectedIds: Set<string>;
  onToggleSelect: () => void;
  onOpen: () => void;
  onMove: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const action = useAction(async (kind: 'rename' | 'reprocess') => {
    if (kind === 'rename') {
      const name = window.prompt('New name', item.name);
      if (!name || name === item.name) return;
      await api.patch(`/orgs/${orgId}/media/${item.id}`, { name });
    } else {
      await api.post(`/orgs/${orgId}/media/${item.id}/reprocess`);
    }
    onChanged();
  });

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-white shadow-sm ${
        selected ? 'border-blue-400 ring-1 ring-blue-300' : 'border-slate-200'
      }`}
      draggable
      onDragStart={(e) => {
        // Drag the whole selection when this card is part of it.
        const ids = selected && selectedIds.size > 0 ? [...selectedIds] : [item.id];
        e.dataTransfer.setData('application/x-media-ids', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="relative aspect-video cursor-pointer bg-slate-100" onClick={onOpen}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-3xl text-slate-300">
            {item.mediaType === 'video' ? '🎬' : '🖼'}
          </div>
        )}
        <input
          type="checkbox"
          className="absolute left-1.5 top-1.5 h-4 w-4"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
        />
        {item.durationSeconds ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
            {formatDuration(item.durationSeconds)}
          </span>
        ) : null}
      </div>
      <div className="space-y-2 p-3">
        <p className="truncate text-sm font-medium text-slate-800" title={item.name}>
          {item.name}
        </p>
        {showFolder ? (
          <p className="truncate text-xs text-slate-400" title={item.folderPath ?? 'Root folder'}>
            📁 {item.folderPath ?? 'Root'}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[item.processingStatus] ?? 'gray'}>{item.processingStatus}</Badge>
          <Badge tone="blue">{item.mediaType}</Badge>
          {item.orientation ? <Badge>{item.orientation}</Badge> : null}
          {item.usedInPlaylistCount ? (
            <Badge tone="green">
              in {item.usedInPlaylistCount} playlist{item.usedInPlaylistCount === 1 ? '' : 's'}
            </Badge>
          ) : null}
          <span className="text-xs text-slate-400">{formatBytes(item.sizeBytes)}</span>
        </div>
        <p className="text-xs text-slate-400">
          ▶ {item.playCount ?? 0} plays
          {item.lastPlayedAt ? ` · last ${timeAgo(item.lastPlayedAt)}` : ''}
        </p>
        {item.processingStatus === 'failed' && item.processingError ? (
          <p className="break-words text-xs text-red-600" title={item.processingError}>
            {item.processingError.slice(0, 120)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1 pt-1">
          {item.previewUrl ? (
            <a
              href={item.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
            >
              Preview
            </a>
          ) : null}
          <Button variant="ghost" small onClick={() => action.run('rename')} disabled={action.busy}>
            Rename
          </Button>
          <Button variant="ghost" small onClick={onMove}>
            Move
          </Button>
          {item.processingStatus === 'failed' ? (
            <Button
              variant="ghost"
              small
              onClick={() => action.run('reprocess')}
              disabled={action.busy}
            >
              Retry
            </Button>
          ) : null}
          <Button variant="ghost" small onClick={onDelete}>
            Delete
          </Button>
        </div>
        <ErrorNote message={action.error} />
      </div>
    </div>
  );
}

// -------------------------------------------------------- folder dialogs

function CreateFolderModal({
  orgId,
  parent,
  onClose,
  onCreated,
}: {
  orgId: string;
  parent: MediaFolderDto | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const submit = useAction(async () => {
    await api.post(`/orgs/${orgId}/media/folders`, {
      name,
      parentFolderId: parent?.id ?? null,
    });
    onCreated();
  });

  return (
    <Modal title={parent ? `New folder inside "${parent.name}"` : 'New folder'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.run();
        }}
        className="space-y-4"
      >
        <Field label="Folder name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameFolderModal({
  orgId,
  folder,
  onClose,
  onSaved,
}: {
  orgId: string;
  folder: MediaFolderDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const submit = useAction(async () => {
    await api.patch(`/orgs/${orgId}/media/folders/${folder.id}`, { name });
    onSaved();
  });

  return (
    <Modal title="Rename folder" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.run();
        }}
        className="space-y-4"
      >
        <Field label="Folder name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Saving…' : 'Rename'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteFolderDialog({
  orgId,
  folder,
  folders,
  onClose,
  onDeleted,
}: {
  orgId: string;
  folder: MediaFolderDto;
  folders: MediaFolderDto[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const usage = useApi(
    () => api.get<FolderUsageDto>(`/orgs/${orgId}/media/folders/${folder.id}/usage`),
    [orgId, folder.id],
  );
  const [strategy, setStrategy] = useState<'move_to_root' | 'move_to_folder' | 'delete_media'>(
    'move_to_root',
  );
  const [targetFolderId, setTargetFolderId] = useState('');

  const submit = useAction(async () => {
    if (strategy === 'move_to_folder' && !targetFolderId) {
      throw new Error('Choose a target folder');
    }
    await api.delete(`/orgs/${orgId}/media/folders/${folder.id}`, {
      strategy,
      ...(strategy === 'move_to_folder' ? { targetFolderId } : {}),
    });
    onDeleted();
  });

  const u = usage.data;
  const hasPlaylistImpact =
    !!u &&
    (u.directPlaylistRefs.length > 0 ||
      u.mediaPlaylistRefs.length > 0 ||
      u.priorityRuleRefs.length > 0);

  // Folders outside the deleted subtree are valid move targets.
  const targetOptions = folders.filter(
    (f) => f.id !== folder.id && !f.path.startsWith(`${folder.path} / `),
  );

  return (
    <Modal title={`Delete folder "${folder.name}"`} onClose={onClose}>
      {usage.loading && !u ? <Spinner /> : null}
      <ErrorNote message={usage.error} />
      {u ? (
        <div className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <p>
              This folder contains <strong>{u.mediaCount}</strong> media file(s) and{' '}
              <strong>{u.subfolderCount}</strong> subfolder(s).
            </p>
            {u.directPlaylistRefs.length > 0 ? (
              <p className="mt-1 text-amber-700">
                ⚠ Referenced as a dynamic folder by {u.directPlaylistRefs.length} playlist(s):{' '}
                {u.directPlaylistRefs.map((p) => p.name).join(', ')}. Those entries will be removed.
              </p>
            ) : null}
            {u.mediaPlaylistRefs.length > 0 ? (
              <p className="mt-1 text-amber-700">
                ⚠ Media inside is used directly by {u.mediaPlaylistRefs.length} playlist(s):{' '}
                {u.mediaPlaylistRefs.map((p) => p.name).join(', ')}.
              </p>
            ) : null}
            {u.priorityRuleRefs.length > 0 ? (
              <p className="mt-1 text-amber-700">
                ⚠ Used by {u.priorityRuleRefs.length} priority rule(s):{' '}
                {u.priorityRuleRefs.map((r) => `${r.name} (${r.playlistName})`).join(', ')}.
              </p>
            ) : null}
            {u.activeSchedules.length > 0 ? (
              <p className="mt-1 text-red-700">
                ⚠ {u.activeSchedules.length} active schedule(s) and {u.affectedDeviceCount}{' '}
                device(s) are affected — deleting may change live signage playback.
              </p>
            ) : null}
            {!hasPlaylistImpact && u.activeSchedules.length === 0 ? (
              <p className="mt-1 text-slate-500">
                No playlists or schedules reference this folder.
              </p>
            ) : null}
          </div>

          <div className="space-y-2 text-sm text-slate-700">
            <p className="font-medium">What should happen with the media inside?</p>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={strategy === 'move_to_root'}
                onChange={() => setStrategy('move_to_root')}
              />
              Move all media to the root folder
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={strategy === 'move_to_folder'}
                onChange={() => setStrategy('move_to_folder')}
                disabled={targetOptions.length === 0}
              />
              Move all media to another folder
            </label>
            {strategy === 'move_to_folder' ? (
              <div className="pl-6">
                <Select value={targetFolderId} onChange={(e) => setTargetFolderId(e.target.value)}>
                  <option value="">Choose a folder…</option>
                  {targetOptions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.path}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={strategy === 'delete_media'}
                onChange={() => setStrategy('delete_media')}
              />
              Also delete all contained media ({u.mediaCount} file(s))
            </label>
          </div>

          <ErrorNote message={submit.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => submit.run()} disabled={submit.busy}>
              {submit.busy ? 'Deleting…' : 'Delete folder'}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// --------------------------------------------------------- media dialogs

function DeleteMediaDialog({
  orgId,
  media,
  onClose,
  onDeleted,
}: {
  orgId: string;
  media: MediaAssetDto[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const single = media.length === 1 ? media[0] : null;
  const usage = useApi(
    () =>
      single
        ? api.get<MediaUsageDto>(`/orgs/${orgId}/media/${single.id}/usage`)
        : Promise.resolve(null),
    [orgId, single?.id],
  );

  const submit = useAction(async () => {
    if (single) {
      await api.delete(`/orgs/${orgId}/media/${single.id}`);
    } else {
      await api.post(`/orgs/${orgId}/media/bulk-delete`, { mediaIds: media.map((m) => m.id) });
    }
    onDeleted();
  });

  const u = usage.data;

  return (
    <Modal
      title={single ? `Delete "${single.name}"` : `Delete ${media.length} media files`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {single ? (
          <>
            {usage.loading && !u ? <Spinner /> : null}
            <ErrorNote message={usage.error} />
            {u ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {u.directPlaylists.length > 0 ? (
                  <p className="text-amber-700">
                    ⚠ Used directly in {u.directPlaylists.length} playlist(s):{' '}
                    {u.directPlaylists.map((p) => p.name).join(', ')}
                  </p>
                ) : null}
                {u.folderPlaylists.length > 0 ? (
                  <p className="mt-1 text-amber-700">
                    ⚠ Included via folder entries in {u.folderPlaylists.length} playlist(s):{' '}
                    {u.folderPlaylists.map((p) => p.name).join(', ')}
                  </p>
                ) : null}
                {u.priorityRules.length > 0 ? (
                  <p className="mt-1 text-amber-700">
                    ⚠ Used by {u.priorityRules.length} priority rule(s):{' '}
                    {u.priorityRules.map((r) => `${r.name} (${r.playlistName})`).join(', ')}
                  </p>
                ) : null}
                {u.activeSchedules.length > 0 ? (
                  <p className="mt-1 text-red-700">
                    ⚠ Part of {u.activeSchedules.length} active schedule(s) affecting{' '}
                    {u.affectedDeviceCount} device(s) — deleting may change live signage playback.
                  </p>
                ) : null}
                <p className="mt-1 text-slate-500">
                  Played {u.playCount} time(s) in total.
                  {u.directPlaylists.length === 0 &&
                  u.folderPlaylists.length === 0 &&
                  u.priorityRules.length === 0
                    ? ' Not used by any playlist.'
                    : ''}
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-600">
            The selected files are removed from all playlists and priority rules. Playlists using
            their folders dynamically will stop playing them after the next device sync.
          </p>
        )}
        <p className="text-sm text-slate-600">
          Deletion is a soft delete: storage objects are kept and cached copies on devices are
          cleaned up by the normal sync.
        </p>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => submit.run()} disabled={submit.busy}>
            {submit.busy ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MediaDetailModal({
  orgId,
  media,
  onClose,
}: {
  orgId: string;
  media: MediaAssetDto;
  onClose: () => void;
}) {
  const stats = useApi(
    () => api.get<MediaPlaybackStatsDto>(`/orgs/${orgId}/media/${media.id}/playback-stats`),
    [orgId, media.id],
  );

  return (
    <Modal title={media.name} onClose={onClose} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="overflow-hidden rounded-md bg-slate-100">
            {media.previewUrl && media.mediaType === 'image' ? (
              <img src={media.previewUrl} alt={media.name} className="w-full object-contain" />
            ) : media.previewUrl && media.mediaType === 'video' ? (
              <video src={media.previewUrl} controls muted className="w-full" />
            ) : media.thumbnailUrl ? (
              <img src={media.thumbnailUrl} alt={media.name} className="w-full object-contain" />
            ) : (
              <div className="flex h-40 items-center justify-center text-4xl text-slate-300">
                {media.mediaType === 'video' ? '🎬' : '🖼'}
              </div>
            )}
          </div>
          <dl className="mt-3 space-y-1 text-sm text-slate-600">
            <div className="flex justify-between">
              <dt>File</dt>
              <dd className="text-slate-800">{media.originalFilename}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Type</dt>
              <dd>
                {media.mediaType}
                {media.orientation ? ` · ${media.orientation}` : ''}
                {media.width && media.height ? ` · ${media.width}×${media.height}` : ''}
              </dd>
            </div>
            {media.durationSeconds ? (
              <div className="flex justify-between">
                <dt>Duration</dt>
                <dd>{formatDuration(media.durationSeconds)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt>Folder</dt>
              <dd>{media.folderPath ?? 'Root'}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Uploaded</dt>
              <dd>{formatDateTime(media.createdAt)}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-800">Playback</h3>
          {stats.loading && !stats.data ? <Spinner /> : null}
          <ErrorNote message={stats.error} />
          {stats.data ? (
            <div className="space-y-3 text-sm text-slate-600">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md bg-slate-50 p-2">
                  <div className="text-lg font-semibold text-slate-800">
                    {stats.data.totalPlayCount}
                  </div>
                  <div className="text-xs">total plays</div>
                </div>
                <div className="rounded-md bg-slate-50 p-2">
                  <div className="text-lg font-semibold text-slate-800">
                    {stats.data.lastPlayedAt ? timeAgo(stats.data.lastPlayedAt) : 'never'}
                  </div>
                  <div className="text-xs">last played</div>
                </div>
              </div>
              {stats.data.firstPlayedAt ? (
                <p className="text-xs text-slate-400">
                  First played {formatDateTime(stats.data.firstPlayedAt)}
                </p>
              ) : null}
              {stats.data.perDevice.length > 0 ? (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase text-slate-400">
                    Recent screens
                  </h4>
                  <ul className="space-y-0.5">
                    {stats.data.perDevice.map((d) => (
                      <li key={d.deviceId} className="flex justify-between">
                        <span className="truncate">{d.deviceName}</span>
                        <span className="text-slate-400">
                          {d.playCount}× · {timeAgo(d.lastPlayedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {stats.data.perPlaylist.length > 0 ? (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase text-slate-400">
                    Recent playlists
                  </h4>
                  <ul className="space-y-0.5">
                    {stats.data.perPlaylist.map((p) => (
                      <li key={p.playlistId} className="flex justify-between">
                        <span className="truncate">{p.playlistName}</span>
                        <span className="text-slate-400">
                          {p.playCount}× · {timeAgo(p.lastPlayedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <DisplayModeTester media={media} />
    </Modal>
  );
}

/** Lets the user try fit modes / background / position against this media without saving. */
function DisplayModeTester({ media }: { media: MediaAssetDto }) {
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const [display, setDisplay] = useState<DisplayValue>({
    fitMode: 'contain',
    backgroundColor: '#000000',
    positionMode: 'center',
  });
  const eff = resolveDisplaySettings(display);

  return (
    <details className="mt-4 border-t border-slate-100 pt-4">
      <summary className="cursor-pointer text-sm font-semibold text-slate-800">
        Try display modes
      </summary>
      <p className="mt-1 text-xs text-slate-500">
        Preview how this media looks with each fit mode. This does not change any playlist.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="space-y-3">
          <div className="flex gap-2 text-xs">
            {(['landscape', 'portrait'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOrientation(o)}
                className={`rounded-md border px-2 py-1 ${
                  orientation === o
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-slate-300 text-slate-600'
                }`}
              >
                {o === 'landscape' ? 'Landscape screen' : 'Portrait screen'}
              </button>
            ))}
          </div>
          <DisplaySettingsControls value={display} onChange={setDisplay} />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-600">Preview</span>
          <MediaDisplayPreview
            thumbnailUrl={media.previewUrl ?? media.thumbnailUrl}
            mediaType={media.mediaType}
            width={media.width}
            height={media.height}
            orientation={orientation}
            fitMode={eff.fitMode}
            backgroundColor={eff.backgroundColor}
            positionMode={eff.positionMode}
          />
        </div>
      </div>
    </details>
  );
}
