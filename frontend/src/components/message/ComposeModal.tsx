import { useState, useEffect, useRef } from 'react';
import { Send, Paperclip, X } from 'lucide-react';
import type { MessageType, MessagePriority, MessageAttachment } from '@/types';
import { useAsyncCallback } from '@/hooks/useAsync';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RecipientPicker, type MemberOption } from '@/components/message/RecipientPicker';
// The compose "To" field prefills the configured support alias (passed in via
// the `supportAlias` prop, sourced from the server's SUPPORT_ALIASES). This
// module constant is only the fallback until that config loads. A send to a
// support alias is translated to recipientOrgId = "system" with
// channel = "support" so system-org readers can filter by channel.
const DEFAULT_SUPPORT_ALIAS = 'support@pipeline-builder';
// The system tenant's well-known org id (api-core SYSTEM_ORG_ID default). The
// support inbox is the system org; messages to support are addressed to this id.
const SUPPORT_RECIPIENT = '000000000000000000000001';
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
  }) => Promise<boolean>;
  /** Whether the current user holds `messages:write` — enables full compose
   *  (address another org/team directly) instead of the support-only contact
   *  form. Users without it see the support-alias pre-fill with their own org's
   *  other teams as datalist suggestions. */
  canWrite: boolean;
  /** Whether the current user is a sysadmin. Gates ONLY the broadcast
   *  announcement toggle (recipient `*` fans out to every org) — a genuine
   *  platform-operator capability, so it stays sysadmin-only even for
   *  `messages:write` holders. */
  isSuperAdmin: boolean;
  /** Other orgs/teams the user can message (e.g. teams they belong to). Feeds the
   *  team typeahead in the full-compose recipient picker (value = org id, label =
   *  name) and the support-only datalist. */
  recipientSuggestions?: ReadonlyArray<{ value: string; label: string }>;
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
export function ComposeModal({ isOpen, onClose, onSend, canWrite, isSuperAdmin, recipientSuggestions = [], supportAlias = DEFAULT_SUPPORT_ALIAS, supportAliases, fetchMembers, onUploadAttachment }: ComposeModalProps) {
  // Every configured support alias (falls back to the single primary). Used both
  // to seed the picker and to recognize a support send regardless of which alias.
  const aliasList = supportAliases?.length ? supportAliases : [supportAlias];
  const aliasSet = new Set(aliasList.map((a) => a.toLowerCase()));
  // BOTH To-fields default to the configured support alias, so "New Message" is a
  // one-click contact-support flow for everyone. A full-compose (`messages:write`)
  // user can overwrite it with an org id / team; leaving it as the alias routes to
  // the system support inbox on send (see handleSend), same as the support-only user.
  const [recipientOrgId, setRecipientOrgId] = useState(supportAlias);
  const [supportRecipient, setSupportRecipient] = useState(supportAlias);
  // Optional per-user target within recipientOrgId ('' = whole org). Full-compose
  // only; cleared whenever the recipient org changes (handled in RecipientPicker).
  const [recipientUserId, setRecipientUserId] = useState('');
  const [content, setContent] = useState('');
  const [validationError, setValidationError] = useState('');
  const [isAnnouncement, setIsAnnouncement] = useState(false);
  // Attachments uploaded (pending) for this compose — their ids are linked on send.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Apply the configured alias to the To fields when the modal opens — the
  // `supportAlias` config loads asynchronously, so the initial useState value
  // may have been the fallback. Only overwrites a field still holding an alias
  // (fallback or configured), never a value the user has typed over.
  useEffect(() => {
    if (!isOpen) return;
    setRecipientOrgId((cur) => (cur === DEFAULT_SUPPORT_ALIAS || cur === '' ? supportAlias : cur));
    setSupportRecipient((cur) => (cur === DEFAULT_SUPPORT_ALIAS || cur === '' ? supportAlias : cur));
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
    setIsAnnouncement(false);
  }, [isOpen]);

  const { execute: sendAsync, loading: sending, error: sendError } = useAsyncCallback(
    (data: Parameters<typeof onSend>[0]) => onSend(data),
  );

  const error = validationError || sendError || '';

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

    // The active To-field depends on whether the user has full compose rights.
    const activeRecipient = (canWrite ? recipientOrgId : supportRecipient).trim();
    // Leaving the To field as the configured support alias (either field) routes
    // to the system support inbox with the support channel, regardless of compose
    // rights. Any other value is passed through as recipientOrgId (the server also
    // resolves any configured alias / authorizes the target).
    const isSupportSend = !isAnnouncement && aliasSet.has(activeRecipient.toLowerCase());
    const recipient = isAnnouncement
      ? '*'
      : (isSupportSend ? SUPPORT_RECIPIENT : activeRecipient.toLowerCase());
    if (!isAnnouncement && !recipient) {
      setValidationError(canWrite
        ? 'Recipient organization is required'
        : 'Recipient is required');
      return;
    }

    // Only support-channel sends carry the channel field. Direct-to-
    // teammate sends are org-to-org so they don't need a channel tag.
    const channel = isSupportSend ? SUPPORT_CHANNEL : undefined;

    // Per-user targeting applies ONLY to a full-compose, concrete-org
    // conversation — never a support send, broadcast, or support-only user.
    const targetUserId =
      canWrite && !isAnnouncement && !isSupportSend && recipientUserId.trim()
        ? recipientUserId.trim()
        : undefined;

    const result = await sendAsync({
      recipientOrgId: recipient,
      messageType: isAnnouncement ? 'announcement' : 'conversation',
      subject: autoSubject(content),
      content: content.trim(),
      priority: 'normal',
      ...(channel && { channel }),
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
      setSupportRecipient(supportAlias);
      setRecipientUserId('');
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
      setValidationError(err instanceof Error ? err.message : 'Attachment upload failed');
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (id: string) => setAttachments((cur) => cur.filter((a) => a.id !== id));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
                    ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                Message
              </button>
              <button
                onClick={() => setIsAnnouncement(true)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  isAnnouncement
                    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                Announcement
              </button>
            </div>
          )}

          {/* Recipient picker (full-compose users only): team typeahead + an
              optional per-user target with member typeahead. Falls back to a
              free-text datalist input when no member-search fn is supplied. */}
          {canWrite && !isAnnouncement && (
            fetchMembers ? (
              <RecipientPicker
                supportAlias={supportAlias}
                supportAliases={aliasList}
                teamOptions={recipientSuggestions}
                recipientOrgId={recipientOrgId}
                onRecipientOrgIdChange={setRecipientOrgId}
                recipientUserId={recipientUserId}
                onRecipientUserIdChange={setRecipientUserId}
                fetchMembers={fetchMembers}
              />
            ) : (
              <Input
                type="text"
                value={recipientOrgId}
                onChange={(e) => setRecipientOrgId(e.target.value)}
                list="compose-recipient-options"
                placeholder="To: Organization ID"
                aria-label="Recipient organization"
              />
            )
          )}

          {/* Support-only user: pre-filled support recipient (editable; type
              to override with one of the user's other teams). */}
          {!canWrite && (
            <div className="flex items-center gap-2 text-sm bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <span className="text-gray-500 dark:text-gray-400">To:</span>
              <input
                type="text"
                value={supportRecipient}
                onChange={(e) => setSupportRecipient(e.target.value)}
                list="compose-recipient-options"
                className="flex-1 bg-transparent text-gray-700 dark:text-gray-300 font-medium border-none focus:outline-none focus:ring-0"
                aria-label="Recipient (defaults to support; type a teammate or team name to override)"
              />
            </div>
          )}

          {/* Shared recipient suggestions — the configured support alias plus any
              teams the user can message; referenced by both To inputs above. */}
          {!isAnnouncement && (
            <datalist id="compose-recipient-options">
              {aliasList.map((alias) => (
                <option key={alias} value={alias}>
                  {alias.toLowerCase() === supportAlias.toLowerCase() ? 'Pipeline Builder Support' : alias}
                </option>
              ))}
              {recipientSuggestions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
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
                className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50"
              >
                <Paperclip className="w-4 h-4" />
                {uploading ? 'Uploading…' : 'Attach files'}
              </button>
              {attachments.length > 0 && (
                <ul className="space-y-1">
                  {attachments.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-2 text-xs bg-gray-50 dark:bg-gray-800 rounded px-2 py-1"
                    >
                      <Paperclip className="w-3 h-3 text-gray-400 shrink-0" />
                      <span className="truncate flex-1 text-gray-700 dark:text-gray-300">{a.filename}</span>
                      <span className="text-gray-400 shrink-0">{Math.max(1, Math.round(a.sizeBytes / 1024))} KB</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="text-gray-400 hover:text-red-600 shrink-0"
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
