import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PlaylistDto } from '@signage/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  TableCard,
  Td,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { formatDuration } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';

export const ORDER_MODE_LABELS: Record<string, string> = {
  manual_order: 'manual',
  alphabetical: 'A–Z',
  random: 'random',
  random_with_priority_rules: 'random + priority',
};

export function PlaylistsPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const playlists = useApi(() => api.get<PlaylistDto[]>(`/orgs/${orgId}/playlists`), [orgId]);
  const [showCreate, setShowCreate] = useState(false);

  const remove = useAction(async (playlist: PlaylistDto) => {
    if (!window.confirm(`Delete playlist "${playlist.name}"?`)) return;
    await api.delete(`/orgs/${orgId}/playlists/${playlist.id}`);
    playlists.reload();
  });

  const duplicate = useAction(async (playlist: PlaylistDto) => {
    const clone = await api.post<PlaylistDto>(`/orgs/${orgId}/playlists/${playlist.id}/clone`);
    navigate(`/playlists/${clone.id}`);
  });

  return (
    <div>
      <PageHeader
        title="Playlists"
        subtitle="Ordered sets of media played on your screens"
        actions={<Button onClick={() => setShowCreate(true)}>New playlist</Button>}
      />

      <ErrorNote message={playlists.error ?? remove.error ?? duplicate.error} />
      {playlists.loading ? <Spinner /> : null}

      {playlists.data && playlists.data.length === 0 ? (
        <EmptyState title="No playlists yet" hint="Create a playlist, then add media to it." />
      ) : null}

      {playlists.data && playlists.data.length > 0 ? (
        <TableCard>
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Name</Th>
                <Th>Items</Th>
                <Th>Duration</Th>
                <Th>Order</Th>
                <Th>Loop</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {playlists.data.map((playlist) => (
                <tr
                  key={playlist.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/playlists/${playlist.id}`)}
                >
                  <Td>
                    <div className="font-medium text-slate-900">{playlist.name}</div>
                    {playlist.description ? (
                      <div className="text-xs text-slate-500">{playlist.description}</div>
                    ) : null}
                  </Td>
                  <Td>{playlist.itemCount}</Td>
                  <Td>{formatDuration(playlist.totalDurationSeconds)}</Td>
                  <Td>
                    <Badge tone={playlist.playbackOrderMode === 'manual_order' ? 'gray' : 'blue'}>
                      {ORDER_MODE_LABELS[playlist.playbackOrderMode] ?? playlist.playbackOrderMode}
                    </Badge>
                  </Td>
                  <Td>{playlist.loop ? <Badge tone="green">loop</Badge> : <Badge>once</Badge>}</Td>
                  <Td>
                    <Button
                      variant="ghost"
                      small
                      disabled={duplicate.busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        duplicate.run(playlist);
                      }}
                    >
                      Duplicate
                    </Button>
                    <Button
                      variant="ghost"
                      small
                      onClick={(e) => {
                        e.stopPropagation();
                        remove.run(playlist);
                      }}
                    >
                      Delete
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}

      {showCreate ? (
        <CreatePlaylistModal
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onCreated={(playlist) => navigate(`/playlists/${playlist.id}`)}
        />
      ) : null}
    </div>
  );
}

function CreatePlaylistModal({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: (playlist: PlaylistDto) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loop, setLoop] = useState(true);
  const [defaultDuration, setDefaultDuration] = useState(10);

  const submit = useAction(async () => {
    const playlist = await api.post<PlaylistDto>(`/orgs/${orgId}/playlists`, {
      name,
      description: description || undefined,
      loop,
      defaultImageDurationSeconds: defaultDuration,
    });
    onCreated(playlist);
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title="New playlist" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Default image duration (seconds)">
          <Input
            type="number"
            min={1}
            max={86400}
            value={defaultDuration}
            onChange={(e) => setDefaultDuration(Number(e.target.value))}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Loop playlist
        </label>
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
