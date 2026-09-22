import { useState, useEffect, useRef } from 'react';
import { useIsDirty } from '@/hooks/useIsDirty';
import { Send, Paperclip, X } from 'lucide-react';
import type { MessageType, MessagePriority, MessageAttachment } from '@/types';
import { useAsyncCallback } from '@/hooks/useAsync';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RecipientPicker, type MemberOption } from '@/components/message/RecipientPicker';
import { aliasLocalPart } from '@/lib/support-label';
import { DEFAULT_SUPPORT_ALIAS, SYSTEM_ORG_ID, formatError } from '@/lib/constants';
import { formatBytes } from '@/lib/format';
// The compose "To" field prefills the configured support alias (passed in via
// the `supportAlias` prop, sourced from the server's SUPPORT_ALIASES). This
// module constant is only the fallback until that config loads. A send to a
// support alias is translated to recipientOrgId = "system" with
// channel = "support" so system-org readers can filter by channel.
const SUPPORT_CHANNEL = 'support';

/** Props for the ComposeModal component. */
interface ComposeModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback to send the composed message; resolves to `true` on success
   *  and `false` on a recoverable failure (the modal stays open so the user
   *  can edit and retry). Throws bubble up to `useAsyncCallback`'s `error`. */
  onSend: (data: {
    recipientOrgId: string;
    recipientUserId?: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
    channel?: string;
    attachmentIds?: string[];
    /** Route this through the contact-support endpoint (`POST /messages/support`),
     *  which forces the recipient server-side and needs only `messages:read`. */
    support?: boolean;
  }) => Promise<boolean>;
  /** Whether the current user holds `messages:write` — enables full compose
   *  (address another org/team directly) instead of the support-only contact
   *  form. Without it the recipient is not a choice at all: the only send such a
   *  member may make is to support, so the "To" field is shown, fixed, as the
   *  support alias. */
  canWrite: boolean;
  /** Whether the current user is a sysadmin. Gates ONLY the broadcast
   *  announcement toggle (recipient `*` fans out to every org) — a genuine
   *  platform-operator capability, so it stays sysadmin-only even for
   *  `messages:write` holders. */
  isSuperAdmin: boolean;
  /** Other orgs/teams the user can message (every org in their account). Feeds the
   *  team typeahead in the full-compose recipient picker (value = org id, label =
   *  name, `isTeam` marks a team) and the support-only datalist. */
  recipientSuggestions?: ReadonlyArray<{ value: string; label: string; isTeam?: boolean }>;
  /** Recently-messaged orgs (most-recent first) for a one-tap quick-pick above the
   *  recipient field. Value = org id, label = name. */
  recentRecipients?: ReadonlyArray<{ value: string; label: string }>;
  /** Cross-org directory search (#8) — supplied only for sysadmins (who alone may
   *  message an org they don't belong to). Feeds the recipient combobox so they can
   *  find any org by name; omitted ⇒ compose stays limited to own/recent orgs. */
  searchRecipients?: (query: string) => Promise<Array<{ value: string; label: string }>>;
  /** Support alias to prefill the "To" field with — sourced from the server's
   *  SUPPORT_ALIASES config (see `useFeatures().supportAlias`). Defaults to the
   *  well-known alias until config loads. */
  supportAlias?: string;
  /** All configured support aliases (support@, help@, …) — listed as recipient
   *  suggestions and treated as support sends. Defaults to `[supportAlias]`. */
  supportAliases?: string[];
  /** Server-side member search backing the per-user target typeahead (full
   *  compose only). Omitted ⇒ the picker offers team targeting without the
   *  optional single-user field. */
  fetchMembers?: (orgId: string, search: string) => Promise<MemberOption[]>;
  /** Upload one attachment; resolves to its metadata (id used on send). Omitted
   *  ⇒ the attach control is hidden. */
  onUploadAttachment?: (file: File) => Promise<MessageAttachment>;
}

/** Derives a subject line from message content, truncating to 60 characters. */
function autoSubject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 60) + '...';
}

/** Modal for composing and sending new messages or announcements to organizations. */
export function ComposeModal({ isOpen, onClose, onSend, canWrite, isSuperAdmin, recipientSuggestions = [], recentRecipients = [], searchRecipients, supportAlias = DEFAULT_SUPPORT_ALIAS, supportAliases, fetchMembers, onUploadAttachment }: ComposeModalProps) {
  // Every configured support alias (falls back to the single primary). Used both
  // to seed the picker and to recognize a support send regardless of which alias.
  const aliasList = supportAliases?.length ? supportAliases : [supportAlias];
  const aliasSet = new Set(aliasList.map((a) => a.toLowerCase()));
  // The To-field defaults to the configured support alias, so "New Message" is a
  // one-click contact-support flow for everyone. A full-compose (`messages:write`)
  // user can overwrite it with an org id / team; leaving it as the alias routes to
  // the support desk on send (see handleSend), same as the support-only user —
  // who has no To-field to edit at all.
  const [recipientOrgId, setRecipientOrgId] = useState(supportAlias);
  // Optional per-user target within recipientOrgId ('' = whole org). Full-compose
  // only; cleared whenever the recipient org changes (handled in RecipientPicker).
  const [recipientUserId, setRecipientUserId] = useState('');
  const [content, setContent] = useState('');
  const [validationError, setValidationError] = useState('');
  const [isAnnouncement, setIsAnnouncement] = useState(false);
  // Optional channel/inbox bucket for an org→org send (#7). Support sends set
  // their own 'support' channel; this is for everything else. '' = no channel.
  const [channel, setChannel] = useState('');
  // Bumped to REMOUNT the RecipientPicker when a recent-recipient chip sets the
  // org externally (the picker seeds its display text once per mount).
  const [pickerKey, setPickerKey] = useState(0);

  // Merge recent recipients (first) with the user's team suggestions, de-duped by
  // id — feeds both the picker (so a recent org's NAME resolves) and the datalist.
  const mergedSuggestions = (() => {
    const seen = new Set<string>();
    const out: { value: string; label: string; isTeam?: boolean }[] = [];
    // Team-ness comes from the account listing; a recent chip carries only a name.
    const teamIds = new Set(recipientSuggestions.filter((o) => o.isTeam).map((o) => o.value.toLowerCase()));
    for (const o of [...recentRecipients, ...recipientSuggestions]) {
      const k = o.value.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ value: o.value, label: o.label, ...(teamIds.has(k) && { isTeam: true }) });
    }
    return out;
  })();

  /** Pick a recent recipient: set the org id + remount the picker to show its name. */
  const pickRecent = (value: string) => {
    setRecipientOrgId(value);
    setRecipientUserId('');
    setValidationError('');
    setPickerKey((k) => k + 1);
  };
  // Attachments uploaded (pending) for this compose — their ids are linked on send.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const dirty = useIsDirty({ content, recipientUserId, recipientOrgId, channel, attachmentCount: attachments.length });
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Apply the configured alias to the To fields when the modal opens — the
  // `supportAlias` config loads asynchronously, so the initial useState value
  // may have been the fallback. Only overwrites a field still holding an alias
  // (fallback or configured), never a value the user has typed over.
  useEffect(() => {
    if (!isOpen) return;
    setRecipientOrgId((cur) => (cur === DEFAULT_SUPPORT_ALIAS || cur === '' ? supportAlias : cur));
  }, [isOpen, supportAlias]);

  // Fresh draft each time the modal OPENS — don't carry a cancelled draft or its
  // already-uploaded (orphaned) attachments across opens. Keyed on `isOpen` only
  // so a late-arriving `supportAlias` can't wipe an in-progress compose.
  useEffect(() => {
    if (!isOpen) return;
    setContent('');
    setAttachments([]);
    setValidationError('');
    setRecipientUserId('');
    setChannel('');
    setIsAnnouncement(false);
  }, [isOpen]);

  const { execute: sendAsync, loading: sending, error: sendError } = useAsyncCallback(
    (data: Parameters<typeof onSend>[0]) => onSend(data),
  );

  const error = validationError || sendError || '';

  // A concrete org recipient (not empty / support alias / broadcast) — gates the
  // optional channel selector + the recent-recipient quick-pick.
  const isConcreteRecipient = canWrite && !isAnnouncement && (() => {
    const v = recipientOrgId.trim().toLowerCase();
    return v !== '' && v !== '*' && !aliasSet.has(v);
  })();

  if (!isOpen) return null;

  const handleSend = async () => {
    // In-flight guard: the Send button is disabled while sending, but the Enter
    // key handler calls this directly and bypasses that — without this guard,
    // holding Enter during send latency fires duplicate messages. Also block
    // while an attachment upload is in flight (it wouldn't be linked yet).
    if (sending || uploading) return;
    setValidationError('');

    if (!content.trim()) {
      setValidationError('Message content is required');
      return;
    }

    // Without `messages:write` the recipient was never a choice: the only send
    // available is to support, whose To-field is fixed. A full-compose user
    // leaving the To field as a configured support alias means the same thing.
    const activeRecipient = (canWrite ? recipientOrgId : supportAlias).trim();
    // A support send goes to its OWN route (`POST /messages/support`), which
    // forces the recipient server-side and asks only for `messages:read` — so a
    // read-only member reaches support instead of a 403. Anything else is a
    // POST /messages send with `recipientOrgId` passed through (the server also
    // resolves any configured alias / authorizes the target).
    const isSupportSend = !isAnnouncement && (!canWrite || aliasSet.has(activeRecipient.toLowerCase()));
    const recipient = isAnnouncement
      ? '*'
      : (isSupportSend ? SYSTEM_ORG_ID : activeRecipient.toLowerCase());
    // Only reachable in full compose: a support send and a broadcast both
    // resolve to a recipient without the user typing one.
    if (!isAnnouncement && !recipient) {
      setValidationError('Recipient organization is required');
      return;
    }

    // #6 recipient validation (full-compose, concrete-org only): catch a typo'd
    // name that never resolved to an org. Accept a known team/recent org (by id)
    // or a well-formed 24-hex org id; reject anything else BEFORE the round-trip.
    if (canWrite && !isAnnouncement && !isSupportSend) {
      const knownIds = new Set([...recentRecipients, ...recipientSuggestions].map((o) => o.value.toLowerCase()));
      const isHexOrgId = /^[a-f0-9]{24}$/.test(recipient);
      if (!isHexOrgId && !knownIds.has(recipient)) {
        setValidationError('Pick a team from the list, or paste a valid organization id (24 hex characters).');
        return;
      }
    }

    // Channel: support sends use the reserved 'support' channel; other org→org
    // sends may carry an optional operator-chosen channel (#7). Validate its shape
    // (matches the server's a-z/0-9/-/_ rule) so a bad tag fails fast here.
    const trimmedChannel = channel.trim().toLowerCase();
    if (!isSupportSend && trimmedChannel && !/^[a-z0-9_-]{1,50}$/.test(trimmedChannel)) {
      setValidationError('Channel may only contain lowercase letters, numbers, dashes and underscores.');
      return;
    }
    const sendChannel = isSupportSend ? SUPPORT_CHANNEL : (trimmedChannel || undefined);

    // Per-user targeting applies ONLY to a full-compose, concrete-org
    // conversation — never a support send, broadcast, or support-only user.
    const targetUserId =
      canWrite && !isAnnouncement && !isSupportSend && recipientUserId.trim()
        ? recipientUserId.trim()
        : undefined;

    const result = await sendAsync({
      // Carried for the non-support path only: the support route ignores it
      // (and the client drops it), because the server decides the recipient.
      recipientOrgId: recipient,
      messageType: isAnnouncement ? 'announcement' : 'conversation',
      ...(isSupportSend && { support: true }),
      subject: autoSubject(content),
      content: content.trim(),
      priority: 'normal',
      ...(sendChannel && { channel: sendChannel }),
      ...(targetUserId && { recipientUserId: targetUserId }),
      ...(attachments.length ? { attachmentIds: attachments.map((a) => a.id) } : {}),
    });

    // useAsyncCallback wraps a thrown rejection by surfacing it via `error`
    // and returning `null` from `execute`. Treat both `null` (thrown) and
    // an explicit `false` from `onSend` as "stay open"; only a truthy
    // boolean closes the modal and resets the form.
    if (result === true) {
      setContent('');
      setRecipientOrgId(supportAlias);
      setRecipientUserId('');
      setChannel('');
      setIsAnnouncement(false);
      setAttachments([]);
      onClose();
    }
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-selecting the same file
    if (!onUploadAttachment || files.length === 0) return;
    setValidationError('');
    setUploading(true);
    try {
      for (const file of files) {
        const uploaded = await onUploadAttachment(file);
        setAttachments((cur) => [...cur, uploaded]);
      }
    } catch (err) {
      setValidationError(formatError(err, 'Attachment upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (id: string) => setAttachments((cur) => cur.filter((a) => a.id !== id));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const footer = (
    <div className="flex justify-end gap-3">
      <Button onClick={onClose} variant="ghost" className="text-sm">
        Cancel
      </Button>
      <Button
        onClick={handleSend}
        disabled={sending || uploading || !content.trim()}
        variant="primary"
        className="gap-2 text-sm"
      >
        <Send className="w-4 h-4" />
        {sending ? 'Sending...' : 'Send'}
      </Button>
    </div>
  );

  return (
    <Modal
      title={isAnnouncement ? 'New Announcement' : 'New Message'}
      onClose={onClose}
      maxWidth="max-w-md"
      footer={footer}
      // Drafts are deliberately not persisted (see the unmount note above), so a
      // stray backdrop click was an unrecoverable way to lose a written message.
      dirty={dirty}
      discardMessage="This message hasn't been sent. Closing now discards it."
    >
        {/* Body */}
        <div className="space-y-3">
          <ErrorAlert message={error} />

          {/* System org: toggle announcement vs conversation */}
          {isSuperAdmin && (
            <div className="flex gap-2">
              <button
                onClick={() => setIsAnnouncement(false)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  !isAnnouncement
                    ? 'bg-info-bg border-info-border text-info-strong'
                    : 'border-default text-fg-muted hover:bg-surface-muted'
                }`}
              >
                Message
              </button>
              <button
                onClick={() => setIsAnnouncement(true)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  isAnnouncement
                    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                    : 'border-default text-fg-muted hover:bg-surface-muted'
                }`}
              >
                Announcement
              </button>
            </div>
          )}

          {/* Recent recipients (#1) — one-tap quick-pick of orgs you've messaged. */}
          {canWrite && !isAnnouncement && recentRecipients.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-fg-subtle self-center mr-0.5">Recent:</span>
              {recentRecipients.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => pickRecent(r.value)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                    recipientOrgId.toLowerCase() === r.value.toLowerCase()
                      ? 'bg-info-bg border-info-border text-info-strong'
                      : 'border-default text-fg-muted hover:bg-surface-muted'
                  }`}
                  title={`Message ${r.label}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* Recipient picker (full-compose users only): team typeahead + an
              optional per-user target with member typeahead. Falls back to a
              name-labeled datalist input when no member-search fn is supplied. */}
          {canWrite && !isAnnouncement && (
            fetchMembers ? (
              <RecipientPicker
                key={pickerKey}
                supportAlias={supportAlias}
                supportAliases={aliasList}
                teamOptions={mergedSuggestions}
                recipientOrgId={recipientOrgId}
                onRecipientOrgIdChange={setRecipientOrgId}
                recipientUserId={recipientUserId}
                onRecipientUserIdChange={setRecipientUserId}
                fetchMembers={fetchMembers}
                searchTeams={searchRecipients}
              />
            ) : (
              <Input
                type="text"
                value={recipientOrgId}
                onChange={(e) => setRecipientOrgId(e.target.value)}
                list="compose-recipient-options"
                placeholder="To: team name or organization id"
                aria-label="Recipient organization"
              />
            )
          )}

          {/* Optional channel/inbox bucket for an org→org send (#7). */}
          {isConcreteRecipient && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-muted shrink-0">Channel (optional):</span>
              <Input
                type="text"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                list="compose-channel-options"
                placeholder="e.g. general, billing"
                aria-label="Channel (optional)"
                className="flex-1"
              />
              <datalist id="compose-channel-options">
                <option value="general" />
                <option value="billing" />
                <option value="incident" />
                <option value="help" />
              </datalist>
            </div>
          )}

          {/* Support-only user: the recipient is FIXED. Addressing another org
              needs `messages:write`, so an editable field could only ever offer
              a send the server refuses — and this compose posts to the
              contact-support route, which decides the recipient itself. */}
          {!canWrite && (
            <div className="flex items-center gap-2 text-sm bg-surface-muted rounded-lg px-3 py-2">
              <span className="text-fg-muted">To:</span>
              {/* Show the alias's local-part, as every other support surface does
                  (the datalist below, the inbox sender label) — printing the raw
                  `support@pipeline-builder` here leaked an internal routing
                  address into the one place a read-only member always sees. */}
              <span className="flex-1 text-fg-muted font-medium" data-testid="support-recipient">{aliasLocalPart(supportAlias)}</span>
            </div>
          )}

          {/* Recipient suggestions — the configured support alias plus any teams
              the user can message; referenced by the full-compose To input above
              (the support-only form has no editable recipient). */}
          {canWrite && !isAnnouncement && (
            <datalist id="compose-recipient-options">
              {aliasList.map((alias) => (
                <option key={alias} value={alias}>
                  {aliasLocalPart(alias)}
                </option>
              ))}
              {mergedSuggestions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.isTeam ? `${opt.label} (team)` : opt.label}
                </option>
              ))}
            </datalist>
          )}

          {/* Content */}
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
            rows={4}
            className="resize-none"
          />

          {/* Attachments */}
          {onUploadAttachment && (
            <div className="space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFilesSelected}
                aria-label="Attach files"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50"
              >
                <Paperclip className="w-4 h-4" />
                {uploading ? 'Uploading…' : 'Attach files'}
              </button>
              {attachments.length > 0 && (
                <ul className="space-y-1">
                  {attachments.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-2 text-xs bg-surface-muted rounded px-2 py-1"
                    >
                      <Paperclip className="w-3 h-3 text-fg-subtle shrink-0" />
                      <span className="truncate flex-1 text-fg-muted">{a.filename}</span>
                      <span className="text-fg-subtle shrink-0">{formatBytes(a.sizeBytes)}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="text-fg-subtle hover:text-danger shrink-0"
                        aria-label={`Remove ${a.filename}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
    </Modal>
  );
}
