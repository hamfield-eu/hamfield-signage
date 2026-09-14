import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  FitMode,
  MediaFolderDto,
  PlaybackOrderMode,
  PlaylistDto,
  PlaylistItemDto,
  PositionMode,
  PriorityRuleDto,
  ResolvedPreviewDto,
} from '@signage/shared';
import { FIT_MODE_INFO, resolveDisplaySettings } from '@signage/shared';
import type { MediaAssetDto } from '@signage/shared';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from '../components/ui';
import { FolderPickerModal } from '../components/FolderTree';
import { DisplaySettingsControls, type DisplayValue } from '../components/DisplaySettingsControls';
import { MediaDisplayPreview } from '../components/MediaDisplayPreview';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { formatDuration } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { ORDER_MODE_LABELS } from './Playlists';

interface EditableItem {
  key: string;
  type: 'media' | 'folder';
  mediaAssetId: string | null;
  folderId: string | null;
  label: string;
  folderPath?: string;
  mediaType: 'image' | 'video' | null;
  mediaDuration: number | null;
  thumbnailUrl?: string | null;
  durationSeconds: number | null;
  fitMode: FitMode | null;
  backgroundColor: string | null;
  positionMode: PositionMode | null;
  enabled: boolean;
  includeSubfolders: boolean;
  filterMediaType: '' | 'image' | 'video';
  filterOrientation: '' | 'landscape' | 'portrait' | 'square';
}

let nextKey = 1;

function toEditable(item: PlaylistItemDto): EditableItem {
  return {
    key: `existing-${item.id}`,
    type: item.type,
    mediaAssetId: item.mediaAssetId,
    folderId: item.folderId,
    label:
      item.type === 'folder'
        ? (item.folder?.name ?? 'Deleted folder')
        : (item.media?.name ?? item.mediaAssetId ?? ''),
    folderPath: item.folder?.path,
    mediaType: (item.media?.mediaType ?? null) as EditableItem['mediaType'],
    mediaDuration: item.media?.durationSeconds ?? null,
    thumbnailUrl: item.media?.thumbnailUrl,
    durationSeconds: item.durationSeconds,
    fitMode: item.fitMode,
    backgroundColor: item.backgroundColor,
    positionMode: item.positionMode,
    enabled: item.enabled,
    includeSubfolders: item.includeSubfolders,
    filterMediaType: (item.filterMediaType ?? '') as EditableItem['filterMediaType'],
    filterOrientation: (item.filterOrientation ?? '') as EditableItem['filterOrientation'],
  };
}

/** Direct + (optionally) subfolder media counts from the folder list. */
function folderMediaCount(
  folders: MediaFolderDto[],
  folderId: string,
  includeSubfolders: boolean,
): number {
  const direct = folders.find((f) => f.id === folderId)?.mediaCount ?? 0;
  if (!includeSubfolders) return direct;
  let total = direct;
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const child of folders.filter((f) => f.parentFolderId === id)) {
      total += child.mediaCount ?? 0;
      queue.push(child.id);
    }
  }
  return total;
}

export function PlaylistEditorPage() {
  const orgId = useOrgId();
  const { playlistId = '' } = useParams();
  const navigate = useNavigate();

  const playlist = useApi(
    () => api.get<PlaylistDto>(`/orgs/${orgId}/playlists/${playlistId}`),
    [orgId, playlistId],
  );
  const foldersApi = useApi(
    () => api.get<MediaFolderDto[]>(`/orgs/${orgId}/media/folders`),
    [orgId],
  );
  const folders = foldersApi.data ?? [];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loop, setLoop] = useState(true);
  const [defaultDuration, setDefaultDuration] = useState(10);
  const [orderMode, setOrderMode] = useState<PlaybackOrderMode>('manual_order');
  const [defaults, setDefaults] = useState<DisplayValue>({
    fitMode: null,
    backgroundColor: null,
    positionMode: null,
  });
  const [items, setItems] = useState<EditableItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);

  useEffect(() => {
    if (!playlist.data) return;
    setName(playlist.data.name);
    setDescription(playlist.data.description ?? '');
    setLoop(playlist.data.loop);
    setDefaultDuration(playlist.data.defaultImageDurationSeconds);
    setOrderMode(playlist.data.playbackOrderMode);
    setDefaults({
      fitMode: playlist.data.defaultFitMode,
      backgroundColor: playlist.data.defaultBackgroundColor,
      positionMode: playlist.data.defaultPositionMode,
    });
    setItems((playlist.data.items ?? []).map(toEditable));
    setDirty(false);
  }, [playlist.data]);

  const save = useAction(async () => {
    await api.patch(`/orgs/${orgId}/playlists/${playlistId}`, {
      name,
      description: description || null,
      loop,
      defaultImageDurationSeconds: defaultDuration,
      playbackOrderMode: orderMode,
      defaultFitMode: defaults.fitMode,
      defaultBackgroundColor: defaults.backgroundColor,
      defaultPositionMode: defaults.positionMode,
    });
    await api.put(`/orgs/${orgId}/playlists/${playlistId}/items`, {
      items: items.map((item) => ({
        type: item.type,
        mediaAssetId: item.type === 'media' ? item.mediaAssetId : null,
        folderId: item.type === 'folder' ? item.folderId : null,
        durationSeconds: item.durationSeconds,
        fitMode: item.fitMode,
        backgroundColor: item.backgroundColor,
        positionMode: item.positionMode,
        enabled: item.enabled,
        includeSubfolders: item.includeSubfolders,
        filterMediaType: item.filterMediaType || null,
        filterOrientation: item.filterOrientation || null,
      })),
    });
    setDirty(false);
    playlist.reload();
    setPreviewTick((t) => t + 1);
  });

  const duplicate = useAction(async () => {
    const clone = await api.post<PlaylistDto>(`/orgs/${orgId}/playlists/${playlistId}/clone`);
    navigate(`/playlists/${clone.id}`);
  });

  const mutate = (fn: (items: EditableItem[]) => EditableItem[]) => {
    setItems(fn);
    setDirty(true);
  };

  const move = (index: number, delta: number) => {
    mutate((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const isRandomMode = orderMode === 'random' || orderMode === 'random_with_priority_rules';

  if (playlist.loading && !playlist.data) return <Spinner />;
  if (playlist.error) return <ErrorNote message={playlist.error} />;

  return (
    <div>
      <PageHeader
        title={`Playlist: ${playlist.data?.name ?? ''}`}
        subtitle={`${items.filter((i) => i.enabled).length} active entries · ${ORDER_MODE_LABELS[orderMode]} order`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/playlists')}>
              Back
            </Button>
            <Button variant="secondary" onClick={() => duplicate.run()} disabled={duplicate.busy}>
              {duplicate.busy ? 'Duplicating…' : 'Duplicate'}
            </Button>
            <Button onClick={() => save.run()} disabled={save.busy || !dirty}>
              {save.busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </Button>
          </>
        }
      />
      <ErrorNote message={save.error ?? duplicate.error} />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card title="Playlist settings">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <Field label="Default image duration (s)">
                <Input
                  type="number"
                  min={1}
                  value={defaultDuration}
                  onChange={(e) => {
                    setDefaultDuration(Number(e.target.value));
                    setDirty(true);
                  }}
                />
              </Field>
              <Field
                label="Playback order"
                hint={
                  orderMode === 'manual_order'
                    ? 'Entries play in the order below.'
                    : orderMode === 'alphabetical'
                      ? 'All resolved media plays A–Z by name (natural sort).'
                      : orderMode === 'random'
                        ? 'Shuffled on the screen; every item plays once per cycle.'
                        : 'Shuffled, with priority rules inserting items at intervals.'
                }
              >
                <Select
                  value={orderMode}
                  onChange={(e) => {
                    setOrderMode(e.target.value as PlaybackOrderMode);
                    setDirty(true);
                  }}
                >
                  <option value="manual_order">Manual order</option>
                  <option value="alphabetical">Alphabetical (A–Z)</option>
                  <option value="random">Random</option>
                  <option value="random_with_priority_rules">Random with priority rules</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={loop}
                  onChange={(e) => {
                    setLoop(e.target.checked);
                    setDirty(true);
                  }}
                />
                Loop playlist
              </label>
            </div>
          </Card>

          <Card title="Display defaults">
            <p className="mb-3 text-xs text-slate-500">
              Applied to entries that don’t set their own fit mode, background color, or position.
              The platform default is “Fit to screen” on a black background, centered.
            </p>
            <div className="max-w-md">
              <DisplaySettingsControls
                value={defaults}
                inheritLabel="Platform default"
                onChange={(next) => {
                  setDefaults(next);
                  setDirty(true);
                }}
              />
            </div>
          </Card>

          <Card
            title="Entries"
            actions={
              <Button variant="secondary" small onClick={() => setShowFolderPicker(true)}>
                + Add folder
              </Button>
            }
          >
            {items.length === 0 ? (
              <p className="text-sm text-slate-500">
                No entries yet — add media from the library on the right, or add a whole folder.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((item, index) => (
                  <li key={item.key} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex flex-col gap-0.5">
                        <button
                          className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          aria-label="Move up"
                        >
                          ▲
                        </button>
                        <button
                          className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                          disabled={index === items.length - 1}
                          onClick={() => move(index, 1)}
                          aria-label="Move down"
                        >
                          ▼
                        </button>
                      </div>
                      <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100">
                        {item.type === 'folder' ? (
                          <span className="text-xl">📁</span>
                        ) : item.thumbnailUrl ? (
                          <img
                            src={item.thumbnailUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-lg text-slate-300">
                            {item.mediaType === 'video' ? '🎬' : '🖼'}
                          </span>
                        )}
                      </div>
                      <div className="min-w-[10rem] flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">
                          {item.type === 'folder' ? (item.folderPath ?? item.label) : item.label}
                        </p>
                        <p className="text-xs text-slate-400">
                          {item.type === 'folder' ? (
                            <>
                              dynamic folder ·{' '}
                              {item.folderId
                                ? `${folderMediaCount(folders, item.folderId, item.includeSubfolders)} media`
                                : 'missing'}
                              {item.folderId &&
                              folderMediaCount(folders, item.folderId, item.includeSubfolders) ===
                                0 ? (
                                <span className="text-amber-600"> · empty folder</span>
                              ) : null}
                            </>
                          ) : (
                            <>
                              {item.mediaType}
                              {item.mediaType === 'video' && item.mediaDuration
                                ? ` · ${formatDuration(item.mediaDuration)}`
                                : ''}
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex w-full items-center gap-3 sm:w-auto">
                        <div className="w-24">
                          <Input
                            type="number"
                            min={1}
                            placeholder={
                              item.type === 'folder' || item.mediaType === 'image'
                                ? String(defaultDuration)
                                : 'auto'
                            }
                            value={item.durationSeconds ?? ''}
                            title="Duration in seconds (empty = default)"
                            onChange={(e) =>
                              mutate((list) =>
                                list.map((x) =>
                                  x.key === item.key
                                    ? {
                                        ...x,
                                        durationSeconds: e.target.value
                                          ? Number(e.target.value)
                                          : null,
                                      }
                                    : x,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="w-28 text-xs text-slate-500" title="Fit mode">
                          {FIT_MODE_INFO[item.fitMode ?? 'contain'].label}
                          {item.fitMode ? '' : ' (default)'}
                        </div>
                        <label
                          className="flex items-center gap-1 text-xs text-slate-500"
                          title="Enabled"
                        >
                          <input
                            type="checkbox"
                            checked={item.enabled}
                            onChange={(e) =>
                              mutate((list) =>
                                list.map((x) =>
                                  x.key === item.key ? { ...x, enabled: e.target.checked } : x,
                                ),
                              )
                            }
                          />
                          on
                        </label>
                        <Button
                          variant="ghost"
                          small
                          onClick={() => mutate((list) => list.filter((x) => x.key !== item.key))}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                    {/* The indent lines this up under the title on a wide row;
                        on a phone the row has wrapped, so it only wastes space. */}
                    <details className="mt-2 sm:ml-[6.5rem]">
                      <summary className="cursor-pointer text-xs font-medium text-slate-500">
                        Display settings
                      </summary>
                      <div className="mt-2 grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                        <DisplaySettingsControls
                          value={{
                            fitMode: item.fitMode,
                            backgroundColor: item.backgroundColor,
                            positionMode: item.positionMode,
                          }}
                          inheritLabel="Playlist default"
                          onChange={(next) =>
                            mutate((list) =>
                              list.map((x) => (x.key === item.key ? { ...x, ...next } : x)),
                            )
                          }
                        />
                        <div>
                          <span className="mb-1 block text-xs font-medium text-slate-600">
                            Preview
                          </span>
                          {(() => {
                            const eff = resolveDisplaySettings(
                              {
                                fitMode: item.fitMode,
                                backgroundColor: item.backgroundColor,
                                positionMode: item.positionMode,
                              },
                              {
                                defaultFitMode: defaults.fitMode,
                                defaultBackgroundColor: defaults.backgroundColor,
                                defaultPositionMode: defaults.positionMode,
                              },
                            );
                            return (
                              <MediaDisplayPreview
                                thumbnailUrl={item.thumbnailUrl}
                                mediaType={item.mediaType ?? 'image'}
                                fitMode={eff.fitMode}
                                backgroundColor={eff.backgroundColor}
                                positionMode={eff.positionMode}
                              />
                            );
                          })()}
                        </div>
                      </div>
                    </details>
                    {item.type === 'folder' ? (
                      <div className="ml-[6.5rem] mt-1.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={item.includeSubfolders}
                            onChange={(e) =>
                              mutate((list) =>
                                list.map((x) =>
                                  x.key === item.key
                                    ? { ...x, includeSubfolders: e.target.checked }
                                    : x,
                                ),
                              )
                            }
                          />
                          include subfolders
                        </label>
                        <select
                          className="rounded border border-slate-200 px-1 py-0.5"
                          value={item.filterMediaType}
                          onChange={(e) =>
                            mutate((list) =>
                              list.map((x) =>
                                x.key === item.key
                                  ? {
                                      ...x,
                                      filterMediaType: e.target
                                        .value as EditableItem['filterMediaType'],
                                    }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="">All media</option>
                          <option value="image">Images only</option>
                          <option value="video">Videos only</option>
                        </select>
                        <select
                          className="rounded border border-slate-200 px-1 py-0.5"
                          value={item.filterOrientation}
                          onChange={(e) =>
                            mutate((list) =>
                              list.map((x) =>
                                x.key === item.key
                                  ? {
                                      ...x,
                                      filterOrientation: e.target
                                        .value as EditableItem['filterOrientation'],
                                    }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="">All orientations</option>
                          <option value="landscape">Landscape only</option>
                          <option value="portrait">Portrait only</option>
                          <option value="square">Square only</option>
                        </select>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <PriorityRulesCard
            orgId={orgId}
            playlistId={playlistId}
            active={orderMode === 'random_with_priority_rules'}
            folders={folders}
            onChanged={() => setPreviewTick((t) => t + 1)}
          />
        </div>

        <div className="space-y-4 lg:col-span-2">
          <ResolvedPreviewCard
            orgId={orgId}
            playlistId={playlistId}
            dirty={dirty}
            isRandomMode={isRandomMode}
            tick={previewTick}
            onRefresh={() => setPreviewTick((t) => t + 1)}
          />
          <MediaPicker
            orgId={orgId}
            onAdd={(media) =>
              mutate((list) => [
                ...list,
                {
                  key: `new-${nextKey++}`,
                  type: 'media',
                  mediaAssetId: media.id,
                  folderId: null,
                  label: media.name,
                  mediaType: media.mediaType,
                  mediaDuration: media.durationSeconds,
                  thumbnailUrl: media.thumbnailUrl,
                  durationSeconds: null,
                  fitMode: null,
                  backgroundColor: null,
                  positionMode: null,
                  enabled: true,
                  includeSubfolders: false,
                  filterMediaType: '',
                  filterOrientation: '',
                },
              ])
            }
          />
        </div>
      </div>

      {showFolderPicker ? (
        <FolderPickerModal
          title="Add a folder to the playlist"
          folders={folders}
          confirmLabel="Add folder"
          onClose={() => setShowFolderPicker(false)}
          onPick={(folderId) => {
            setShowFolderPicker(false);
            if (!folderId) return;
            const folder = folders.find((f) => f.id === folderId);
            mutate((list) => [
              ...list,
              {
                key: `new-${nextKey++}`,
                type: 'folder',
                mediaAssetId: null,
                folderId,
                label: folder?.name ?? 'Folder',
                folderPath: folder?.path,
                mediaType: null,
                mediaDuration: null,
                durationSeconds: null,
                fitMode: null,
                backgroundColor: null,
                positionMode: null,
                enabled: true,
                includeSubfolders: false,
                filterMediaType: '',
                filterOrientation: '',
              },
            ]);
          }}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------- resolved preview

function ResolvedPreviewCard({
  orgId,
  playlistId,
  dirty,
  isRandomMode,
  tick,
  onRefresh,
}: {
  orgId: string;
  playlistId: string;
  dirty: boolean;
  isRandomMode: boolean;
  tick: number;
  onRefresh: () => void;
}) {
  const preview = useApi(
    () =>
      api.get<ResolvedPreviewDto>(
        `/orgs/${orgId}/playlists/${playlistId}/resolved-preview?seed=${tick + 1}&sampleSize=30`,
      ),
    [orgId, playlistId, tick],
  );
  const p = preview.data;

  return (
    <Card
      title="Resolved preview"
      actions={
        <Button variant="secondary" small onClick={onRefresh}>
          {isRandomMode ? 'New sample' : 'Refresh'}
        </Button>
      }
    >
      {dirty ? (
        <p className="mb-2 rounded-md bg-yellow-50 px-2 py-1 text-xs text-yellow-700">
          Unsaved changes — the preview shows the last saved version.
        </p>
      ) : null}
      {preview.loading && !p ? <Spinner /> : null}
      <ErrorNote message={preview.error} />
      {p ? (
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">
            <strong>{p.resolvedCount}</strong> playable item(s)
            {p.totalDurationSeconds != null
              ? ` · ~${formatDuration(p.totalDurationSeconds)} per cycle`
              : ''}
            {' · '}
            {ORDER_MODE_LABELS[p.playbackOrderMode]}
          </p>
          {p.warnings.map((warning, i) => (
            <p key={i} className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">
              ⚠ {warning.message}
            </p>
          ))}
          {p.sample ? (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-400">
                Sample sequence (actual playback order will differ)
              </h4>
              <ol className="max-h-48 list-decimal space-y-0.5 overflow-y-auto pl-5 text-xs text-slate-600">
                {p.sample.map((entry, i) => (
                  <li key={i}>
                    {entry.name}
                    {entry.playedAs === 'priority' ? (
                      <span className="ml-1 rounded bg-purple-100 px-1 text-purple-700">
                        {entry.priorityRuleName ?? 'priority'}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase text-slate-400">
              Resolved content ({p.items.length})
            </h4>
            <ul className="max-h-64 space-y-0.5 overflow-y-auto text-xs text-slate-600">
              {p.items.map((item) => (
                <li key={item.entryId} className="flex items-center gap-1.5">
                  <span className="truncate">{item.name}</span>
                  {item.processingStatus !== 'ready' ? (
                    <Badge tone={item.processingStatus === 'failed' ? 'red' : 'yellow'}>
                      {item.processingStatus}
                    </Badge>
                  ) : null}
                  {item.source === 'folder' ? (
                    <span className="shrink-0 text-slate-400">📁 {item.sourceName}</span>
                  ) : null}
                  <span
                    className="shrink-0 text-slate-400"
                    title={`Fit: ${FIT_MODE_INFO[item.effectiveFitMode].label} (${item.displaySource.replace('_', ' ')}) · bg ${item.effectiveBackgroundColor} · ${item.effectivePositionMode}`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm border border-slate-300 align-middle"
                      style={{ backgroundColor: item.effectiveBackgroundColor }}
                    />{' '}
                    {FIT_MODE_INFO[item.effectiveFitMode].label}
                  </span>
                  <span className="ml-auto shrink-0 text-slate-400">
                    {item.durationSeconds != null ? formatDuration(item.durationSeconds) : ''}
                  </span>
                </li>
              ))}
              {p.items.length === 0 ? <li className="text-slate-400">Nothing resolves.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// --------------------------------------------------------- priority rules

function PriorityRulesCard({
  orgId,
  playlistId,
  active,
  folders,
  onChanged,
}: {
  orgId: string;
  playlistId: string;
  active: boolean;
  folders: MediaFolderDto[];
  onChanged: () => void;
}) {
  const rules = useApi(
    () => api.get<PriorityRuleDto[]>(`/orgs/${orgId}/playlists/${playlistId}/priority-rules`),
    [orgId, playlistId],
  );
  const [showCreate, setShowCreate] = useState(false);
  const [assigningRule, setAssigningRule] = useState<PriorityRuleDto | null>(null);

  const update = useAction(async (rule: PriorityRuleDto, patch: Record<string, unknown>) => {
    await api.patch(`/orgs/${orgId}/playlists/${playlistId}/priority-rules/${rule.id}`, patch);
    rules.reload();
    onChanged();
  });

  const remove = useAction(async (rule: PriorityRuleDto) => {
    if (!window.confirm(`Delete priority rule "${rule.name}"?`)) return;
    await api.delete(`/orgs/${orgId}/playlists/${playlistId}/priority-rules/${rule.id}`);
    rules.reload();
    onChanged();
  });

  return (
    <Card
      title="Priority rules"
      actions={
        <Button variant="secondary" small onClick={() => setShowCreate(true)}>
          + New rule
        </Button>
      }
    >
      {!active ? (
        <p className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Priority rules only take effect when the playback order is{' '}
          <strong>random with priority rules</strong>. They are kept but inactive in other modes.
        </p>
      ) : null}
      <ErrorNote message={rules.error ?? update.error ?? remove.error} />
      {rules.loading && !rules.data ? <Spinner /> : null}

      {rules.data && rules.data.length === 0 ? (
        <p className="text-sm text-slate-500">
          No priority rules. Example: “after every 5 normal items, play one sponsor ad”.
        </p>
      ) : null}

      <ul className="space-y-3">
        {(rules.data ?? []).map((rule) => {
          const unavailable = rule.assignments.filter(
            (a) =>
              (a.mediaAssetId && (a.media === null || a.media?.processingStatus === 'failed')) ||
              (a.folderId && a.folder === null),
          );
          const processing = rule.assignments.filter(
            (a) =>
              a.media?.processingStatus === 'pending' || a.media?.processingStatus === 'processing',
          );
          return (
            <li
              key={rule.id}
              className={`rounded-md border p-3 ${
                active && rule.enabled
                  ? 'border-purple-200 bg-purple-50/40'
                  : 'border-slate-200 bg-slate-50/60'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-800">{rule.name}</span>
                {!rule.enabled ? <Badge>disabled</Badge> : null}
                {!active && rule.enabled ? (
                  <Badge tone="yellow">inactive in this mode</Badge>
                ) : null}
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" small onClick={() => setAssigningRule(rule)}>
                    Assign media
                  </Button>
                  <Button
                    variant="ghost"
                    small
                    disabled={update.busy}
                    onClick={() => update.run(rule, { enabled: !rule.enabled })}
                  >
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    small
                    disabled={remove.busy}
                    onClick={() => remove.run(rule)}
                  >
                    Delete
                  </Button>
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <label className="flex items-center gap-1">
                  after every
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    className="w-14 rounded border border-slate-300 px-1 py-0.5"
                    defaultValue={rule.intervalCount}
                    onBlur={(e) => {
                      const value = Number(e.target.value);
                      if (value >= 1 && value !== rule.intervalCount) {
                        update.run(rule, { intervalCount: value });
                      }
                    }}
                  />
                  normal items
                </label>
                <label className="flex items-center gap-1">
                  selection:
                  <select
                    className="rounded border border-slate-300 px-1 py-0.5"
                    value={rule.selectionMode}
                    onChange={(e) => update.run(rule, { selectionMode: e.target.value })}
                  >
                    <option value="rotate">rotate</option>
                    <option value="random">random</option>
                  </select>
                </label>
                <button
                  className="text-blue-600 hover:underline"
                  onClick={() => {
                    const name = window.prompt('Rule name', rule.name);
                    if (name && name !== rule.name) update.run(rule, { name });
                  }}
                >
                  rename
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {rule.assignments.length === 0 ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    ⚠ No media assigned — this rule is ignored
                  </span>
                ) : null}
                {rule.assignments.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200"
                  >
                    {a.folderId
                      ? `📁 ${a.folder?.path ?? 'deleted folder'}${a.includeSubfolders ? ' (+sub)' : ''}`
                      : (a.media?.name ?? 'deleted media')}
                  </span>
                ))}
                {unavailable.length > 0 ? (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">
                    ⚠ {unavailable.length} assignment(s) unavailable (deleted/failed)
                  </span>
                ) : null}
                {processing.length > 0 ? (
                  <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                    ⚠ {processing.length} still processing
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {showCreate ? (
        <CreateRuleModal
          orgId={orgId}
          playlistId={playlistId}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            rules.reload();
            onChanged();
          }}
        />
      ) : null}
      {assigningRule ? (
        <AssignRuleMediaModal
          orgId={orgId}
          playlistId={playlistId}
          rule={assigningRule}
          folders={folders}
          onClose={() => setAssigningRule(null)}
          onSaved={() => {
            setAssigningRule(null);
            rules.reload();
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

function CreateRuleModal({
  orgId,
  playlistId,
  onClose,
  onCreated,
}: {
  orgId: string;
  playlistId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [intervalCount, setIntervalCount] = useState(5);
  const [selectionMode, setSelectionMode] = useState<'rotate' | 'random'>('rotate');

  const submit = useAction(async () => {
    await api.post(`/orgs/${orgId}/playlists/${playlistId}/priority-rules`, {
      name,
      intervalCount,
      selectionMode,
    });
    onCreated();
  });

  return (
    <Modal title="New priority rule" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.run();
        }}
        className="space-y-4"
      >
        <Field label="Name" hint='For example "Sponsor ads"'>
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Interval" hint="Play one item from this rule after every X normal items">
          <Input
            type="number"
            min={1}
            max={1000}
            value={intervalCount}
            onChange={(e) => setIntervalCount(Number(e.target.value))}
          />
        </Field>
        <Field
          label="Selection mode"
          hint="Rotate cycles the assigned files in order; random picks one at random"
        >
          <Select
            value={selectionMode}
            onChange={(e) => setSelectionMode(e.target.value as 'rotate' | 'random')}
          >
            <option value="rotate">Rotate</option>
            <option value="random">Random</option>
          </Select>
        </Field>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Creating…' : 'Create rule'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AssignRuleMediaModal({
  orgId,
  playlistId,
  rule,
  folders,
  onClose,
  onSaved,
}: {
  orgId: string;
  playlistId: string;
  rule: PriorityRuleDto;
  folders: MediaFolderDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState('');
  const media = useApi(
    () =>
      api.get<{ items: MediaAssetDto[] }>(
        `/orgs/${orgId}/media?status=ready&pageSize=100&sort=name&order=asc${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }`,
      ),
    [orgId, search],
  );
  const [selectedMedia, setSelectedMedia] = useState<Set<string>>(
    new Set(rule.assignments.filter((a) => a.mediaAssetId).map((a) => a.mediaAssetId!)),
  );
  const [folderAssignments, setFolderAssignments] = useState(
    rule.assignments
      .filter((a) => a.folderId)
      .map((a) => ({ folderId: a.folderId!, includeSubfolders: a.includeSubfolders })),
  );
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  const submit = useAction(async () => {
    await api.put(`/orgs/${orgId}/playlists/${playlistId}/priority-rules/${rule.id}/assignments`, {
      assignments: [
        ...[...selectedMedia].map((mediaAssetId) => ({ mediaAssetId })),
        ...folderAssignments.map((f) => ({
          folderId: f.folderId,
          includeSubfolders: f.includeSubfolders,
        })),
      ],
    });
    onSaved();
  });

  const toggle = (id: string) => {
    setSelectedMedia((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Modal title={`Assign media to "${rule.name}"`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Input
              placeholder="Search ready media…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant="secondary" small onClick={() => setShowFolderPicker(true)}>
            + Add folder
          </Button>
        </div>

        {folderAssignments.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {folderAssignments.map((f, i) => {
              const folder = folders.find((x) => x.id === f.folderId);
              return (
                <span
                  key={`${f.folderId}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                >
                  📁 {folder?.path ?? f.folderId}
                  <label className="flex items-center gap-0.5">
                    <input
                      type="checkbox"
                      checked={f.includeSubfolders}
                      onChange={(e) =>
                        setFolderAssignments((list) =>
                          list.map((x, j) =>
                            j === i ? { ...x, includeSubfolders: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    +sub
                  </label>
                  <button
                    className="text-slate-400 hover:text-red-600"
                    onClick={() => setFolderAssignments((list) => list.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        {media.loading && !media.data ? <Spinner /> : null}
        <ErrorNote message={media.error} />
        <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
          {(media.data?.items ?? []).map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={selectedMedia.has(item.id)}
                onChange={() => toggle(item.id)}
              />
              <div className="h-8 w-12 shrink-0 overflow-hidden rounded bg-slate-100">
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-slate-300">
                    {item.mediaType === 'video' ? '🎬' : '🖼'}
                  </div>
                )}
              </div>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{item.name}</span>
              <span className="text-xs text-slate-400">{item.mediaType}</span>
            </li>
          ))}
          {media.data && media.data.items.length === 0 ? (
            <li className="px-3 py-4 text-center text-sm text-slate-500">No ready media found.</li>
          ) : null}
        </ul>

        <p className="text-xs text-slate-400">
          {selectedMedia.size} file(s) and {folderAssignments.length} folder(s) assigned.
        </p>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => submit.run()} disabled={submit.busy}>
            {submit.busy ? 'Saving…' : 'Save assignments'}
          </Button>
        </div>
      </div>

      {showFolderPicker ? (
        <FolderPickerModal
          title="Assign a folder to this rule"
          folders={folders.filter((f) => !folderAssignments.some((a) => a.folderId === f.id))}
          confirmLabel="Add folder"
          onClose={() => setShowFolderPicker(false)}
          onPick={(folderId) => {
            setShowFolderPicker(false);
            if (folderId) {
              setFolderAssignments((list) => [...list, { folderId, includeSubfolders: false }]);
            }
          }}
        />
      ) : null}
    </Modal>
  );
}

// ------------------------------------------------------------ media picker

function MediaPicker({ orgId, onAdd }: { orgId: string; onAdd: (media: MediaAssetDto) => void }) {
  const [search, setSearch] = useState('');
  const media = useApi(
    () =>
      api.get<{ items: MediaAssetDto[] }>(
        `/orgs/${orgId}/media?status=ready&pageSize=100${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
    [orgId, search],
  );

  const items = useMemo(() => media.data?.items ?? [], [media.data]);

  return (
    <Card title="Media library" actions={<Badge tone="blue">ready only</Badge>}>
      <div className="mb-3">
        <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {media.loading && !media.data ? <Spinner /> : null}
      {media.error ? <ErrorNote message={media.error} /> : null}
      <ul className="max-h-[24rem] divide-y divide-slate-100 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 py-2">
            <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-slate-100">
              {item.thumbnailUrl ? (
                <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-slate-300">
                  {item.mediaType === 'video' ? '🎬' : '🖼'}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-slate-800">{item.name}</p>
              <p className="text-xs text-slate-400">
                {item.mediaType}
                {item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : ''}
                {item.orientation ? ` · ${item.orientation}` : ''}
                {item.folderPath ? ` · 📁 ${item.folderPath}` : ''}
              </p>
            </div>
            <Button variant="secondary" small onClick={() => onAdd(item)}>
              Add
            </Button>
          </li>
        ))}
        {media.data && items.length === 0 ? (
          <li className="py-4 text-center text-sm text-slate-500">No ready media found.</li>
        ) : null}
      </ul>
    </Card>
  );
}
