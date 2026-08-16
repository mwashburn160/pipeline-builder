import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Send, Megaphone, MessageCircle, AlertTriangle, AlertOctagon, Trash2, Paperclip, X, RefreshCw, Pencil, Check } from 'lucide-react';
import { Textarea } from '@/components/ui/Textarea';
import { IconButton } from '@/components/ui/IconButton';
import { MessageAttachments } from '@/components/message/MessageAttachments';
import api from '@/lib/api';
import type { Message, MessageAttachment } from '@/types';

/**
 * A thread bubble that may be an OPTIMISTIC local reply not yet confirmed by the
 * server. `_status` drives the pending/failed affordances; `_idem` is the stable
 * idempotency key reused on retry so a retried send can't double-post.
 */
type ThreadItem = Message & { _status?: 'sending' | 'failed'; _idem?: string };

/** Stable idempotency key for one optimistic reply attempt (reused on retry). */
function newReplyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Props for the ThreadView component. */
interface ThreadViewProps {
  /** The root message that starts this conversation thread. */
  rootMessage: Message;
  /** The current user's organization ID, used to distinguish sent vs. received messages. */
  currentOrgId: string;
  /** The current user's id — gates the per-message "edit" affordance to the author. */
  currentUserId?: string;
  /** Callback to navigate back to the message list (mobile). */
  onBack: () => void;
  /** Callback to mark the entire thread as read when opened. */
  onThreadRead: (id: string) => void;
  /** Callback to delete the conversation (root message + replies). */
  onDelete?: (id: string) => void;
}

/** Formats a date string as a locale-specific date/time string. */
function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

/** Colored badge indicating message priority; renders nothing for "normal" priority. */
function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'normal') return null;
  const colors = priority === 'urgent'
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
  const Icon = priority === 'urgent' ? AlertOctagon : AlertTriangle;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${colors}`}>
      <Icon className="w-3 h-3" />
      {priority}
    </span>
  );
}

/** Chat-style thread view displaying a conversation with reply input. */
export function ThreadView({ rootMessage, currentOrgId, currentUserId, onBack, onThreadRead, onDelete }: ThreadViewProps) {
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyContent, setReplyContent] = useState('');
  // Inline content-edit state (author-only). `editingId` is the message being
  // edited; `editText` its working copy; `editError` a failed-save message.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');
  const [replyAttachments, setReplyAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic counter for optimistic temp ids — stable within this mount and
  // never collides with a server UUID.
  const optimisticSeq = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const onThreadReadRef = useRef(onThreadRead);
  onThreadReadRef.current = onThreadRead;

  useEffect(() => {
    // Guard against stale responses: fast thread switching can resolve an older
    // fetch after a newer one, rendering the wrong thread. Skip setState if this
    // effect has been superseded (id changed) or the component unmounted.
    let cancelled = false;
    const fetchThread = async () => {
      try {
        setLoading(true);
        const result = await api.getThread(rootMessage.id);
        if (cancelled) return;
        setThread(result.data?.messages || []);
      } catch {
        if (cancelled) return;
        setThread([rootMessage]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchThread();
    // Mark thread as read when viewing
    onThreadReadRef.current(rootMessage.id);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch only on thread id change; rootMessage is the fallback body.
  }, [rootMessage.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread]);

  /** Flip an optimistic bubble to the failed state so its retry/dismiss shows. */
  const markFailed = (tempId: string) =>
    setThread((prev) => prev.map((m) => (m.id === tempId ? { ...m, _status: 'failed' } : m)));

  /** Fire the reply request and reconcile the optimistic bubble in place. */
  const submitReply = async (tempId: string, content: string, attachments: MessageAttachment[], idem: string) => {
    const ids = attachments.map((a) => a.id);
    try {
      const result = await api.replyToMessage(rootMessage.id, content, ids.length ? ids : undefined, idem);
      if (result?.data) {
        // Swap the temp bubble for the authoritative server row (real id/author/time).
        setThread((prev) => prev.map((m) => (m.id === tempId ? (result.data as ThreadItem) : m)));
      } else {
        markFailed(tempId);
      }
    } catch {
      markFailed(tempId);
    }
  };

  const handleSendReply = async () => {
    // Block send while an attachment is still uploading — we snapshot
    // replyAttachments here, so an in-flight upload would otherwise be dropped.
    if (!replyContent.trim() || uploading) return;

    const content = replyContent.trim();
    const attachments = replyAttachments;
    const tempId = `optimistic-${optimisticSeq.current++}`;
    const idem = newReplyKey();

    // Optimistic bubble: borrow the root's shape, override the reply-specific
    // fields, and render immediately so the input can clear without waiting on
    // the round-trip. Reconciled by submitReply on success/failure.
    const optimistic: ThreadItem = {
      ...rootMessage,
      id: tempId,
      threadId: rootMessage.id,
      orgId: currentOrgId,
      createdBy: 'You',
      content,
      attachments,
      createdAt: new Date().toISOString(),
      _status: 'sending',
      _idem: idem,
    };
    setThread((prev) => [...prev, optimistic]);
    setReplyContent('');
    setReplyAttachments([]);

    await submitReply(tempId, content, attachments, idem);
  };

  /** Retry a failed optimistic bubble, reusing its idempotency key. */
  const handleRetry = async (item: ThreadItem) => {
    setThread((prev) => prev.map((m) => (m.id === item.id ? { ...m, _status: 'sending' } : m)));
    await submitReply(item.id, item.content, item.attachments ?? [], item._idem ?? newReplyKey());
  };

  /** Drop a failed optimistic bubble (and restore its text for editing). */
  const handleDismissFailed = (item: ThreadItem) => {
    setThread((prev) => prev.filter((m) => m.id !== item.id));
    setReplyContent((cur) => cur || item.content);
  };

  /** Enter inline-edit mode for one of the author's own messages. */
  const beginEdit = (item: ThreadItem) => {
    setEditingId(item.id);
    setEditText(item.content);
    setEditError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
    setEditError('');
  };

  /** Persist a content edit, then patch the bubble in place (content + editedAt). */
  const saveEdit = async (id: string) => {
    const content = editText.trim();
    if (!content || savingEdit) return;
    setSavingEdit(true);
    setEditError('');
    try {
      const res = await api.editMessage(id, content);
      const updated = res.data?.message;
      if (!updated) throw new Error('Edit failed');
      setThread((prev) => prev.map((m) => (m.id === id ? { ...m, content: updated.content, editedAt: updated.editedAt } : m)));
      cancelEdit();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save edit');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-selecting the same file
    if (files.length === 0) return;
    setUploadError('');
    setUploading(true);
    try {
      for (const file of files) {
        const res = await api.uploadAttachment(file);
        if (res.data?.attachment) setReplyAttachments((cur) => [...cur, res.data!.attachment]);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Attachment upload failed');
    } finally {
      setUploading(false);
    }
  };

  const removeReplyAttachment = (id: string) => setReplyAttachments((cur) => cur.filter((a) => a.id !== id));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <IconButton
          onClick={onBack}
          aria-label="Back"
          className="lg:hidden"
        >
          <ArrowLeft className="w-5 h-5 text-gray-500" />
        </IconButton>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {rootMessage.messageType === 'announcement' ? (
              <Megaphone className="w-4 h-4 text-amber-500 flex-shrink-0" />
            ) : (
              <MessageCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
            )}
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
              {rootMessage.messageType === 'announcement'
                ? 'Announcement'
                : rootMessage.orgId.toLowerCase() === currentOrgId.toLowerCase()
                  ? rootMessage.recipientOrgId
                  : rootMessage.orgId}
            </h2>
            <PriorityBadge priority={rootMessage.priority} />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {rootMessage.subject}
          </p>
        </div>
        {onDelete && (
          <IconButton
            onClick={() => { onDelete(rootMessage.id); onBack(); }}
            tone="danger"
            className="flex-shrink-0"
            title="Delete conversation"
            aria-label="Delete conversation"
          >
            <Trash2 className="w-4 h-4" />
          </IconButton>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          thread.map((msg) => {
            const isMine = msg.orgId.toLowerCase() === currentOrgId.toLowerCase();
            const isSending = msg._status === 'sending';
            const isFailed = msg._status === 'failed';
            const isEditing = editingId === msg.id;
            // Author-only edit affordance: a settled (non-optimistic) message the
            // current user authored. Server re-checks authorship regardless.
            const canEdit = isMine && !isSending && !isFailed && !!currentUserId && msg.createdBy === currentUserId;
            return (
              <div
                key={msg.id}
                className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[75%] rounded-xl px-4 py-2.5 ${
                    isMine
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  } ${isSending ? 'opacity-70' : ''} ${isFailed ? 'ring-2 ring-red-400 dark:ring-red-500' : ''}`}
                >
                  <div className={`flex items-center gap-2 text-xs mb-1 ${isMine ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}>
                    <span>{msg.createdBy} ({msg.orgId})</span>
                    {canEdit && !isEditing && (
                      <button
                        onClick={() => beginEdit(msg)}
                        className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:underline inline-flex items-center gap-0.5"
                        aria-label="Edit message"
                        title="Edit"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="space-y-1.5">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                        className="w-full resize-none text-gray-900 dark:text-gray-100"
                        aria-label="Edit message content"
                      />
                      {editError && <p className="text-xs text-red-200">{editError}</p>}
                      <div className="flex items-center gap-2 justify-end">
                        <button onClick={cancelEdit} disabled={savingEdit} className="text-xs font-medium hover:underline disabled:opacity-50">Cancel</button>
                        <button
                          onClick={() => saveEdit(msg.id)}
                          disabled={savingEdit || !editText.trim()}
                          className="inline-flex items-center gap-1 text-xs font-medium hover:underline disabled:opacity-50"
                        >
                          <Check className="w-3 h-3" /> {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  )}
                  {/* Optimistic bubbles hold no server id yet, so skip the
                      attachment fetch until the real row lands. */}
                  {!isSending && !isFailed && !isEditing && <MessageAttachments messageId={msg.id} attachments={msg.attachments} />}
                  <div className={`text-xs mt-1 ${isMine ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}`}>
                    {isSending ? 'Sending…' : formatDateTime(msg.createdAt)}
                    {msg.editedAt && !isSending && <span className="ml-1 italic">(edited)</span>}
                  </div>
                </div>
                {isFailed && (
                  <div className="flex items-center gap-2 mt-1 text-xs text-red-500 dark:text-red-400">
                    <span>Failed to send</span>
                    <button onClick={() => handleRetry(msg)} className="inline-flex items-center gap-1 font-medium hover:underline">
                      <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                    <button onClick={() => handleDismissFailed(msg)} className="font-medium hover:underline" aria-label="Dismiss failed reply">
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply input */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        {/* Pending reply attachments */}
        {replyAttachments.length > 0 && (
          <ul className="mb-2 space-y-1">
            {replyAttachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-xs bg-gray-50 dark:bg-gray-800 rounded px-2 py-1">
                <Paperclip className="w-3 h-3 text-gray-400 shrink-0" />
                <span className="truncate flex-1 text-gray-700 dark:text-gray-300">{a.filename}</span>
                <span className="text-gray-400 shrink-0">{Math.max(1, Math.round(a.sizeBytes / 1024))} KB</span>
                <button type="button" onClick={() => removeReplyAttachment(a.id)} className="text-gray-400 hover:text-red-600 shrink-0" aria-label={`Remove ${a.filename}`}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {uploadError && <p className="mb-2 text-xs text-red-500 dark:text-red-400">{uploadError}</p>}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
            aria-label="Attach files to reply"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Attach files"
            title={uploading ? 'Uploading…' : 'Attach files'}
            className="p-2.5 rounded-xl text-gray-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <Textarea
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your reply... (Enter to send, Shift+Enter for new line)"
            rows={2}
            className="flex-1 resize-none"
          />
          <button
            onClick={handleSendReply}
            disabled={!replyContent.trim() || uploading}
            aria-label="Send reply"
            className="p-2.5 rounded-xl bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
