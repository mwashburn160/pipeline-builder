// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect, useMemo } from 'react';
import { X, User, Users } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { useCombobox } from '@/hooks/useCombobox';
import { useDebounce } from '@/hooks/useDebounce';

/** A messageable org/team: `value` is the org id sent to the API, `label` its name. */
export interface TeamOption {
  value: string;
  label: string;
}

/** Minimal member shape the user typeahead needs. */
export interface MemberOption {
  id: string;
  username: string;
  email: string;
}

/** Props for {@link RecipientPicker}. */
interface RecipientPickerProps {
  /** Primary support alias — the one labeled "Pipeline Builder Support". */
  supportAlias: string;
  /** All configured support aliases (support@, help@, …) to list as recipients.
   *  Defaults to `[supportAlias]` when omitted. */
  supportAliases?: string[];
  /** Orgs/teams the caller can message (value = org id, label = display name). */
  teamOptions: ReadonlyArray<TeamOption>;
  /** Current recipient org id (raw value sent to the API). */
  recipientOrgId: string;
  /** Notify the parent the recipient org changed (also clears any user target). */
  onRecipientOrgIdChange: (orgId: string) => void;
  /** Current per-user target ('' = whole org). */
  recipientUserId: string;
  /** Notify the parent the per-user target changed. */
  onRecipientUserIdChange: (userId: string) => void;
  /** Server-side member search for the user typeahead. */
  fetchMembers: (orgId: string, search: string) => Promise<MemberOption[]>;
}

/** Friendly label for the well-known support alias. */
const SUPPORT_LABEL = 'Pipeline Builder Support';

/**
 * Two-part recipient picker for composing a message:
 *
 *  1. TEAM/ORG combobox — type a team NAME (or paste a raw org id) and pick from
 *     an autocompleting list; the display shows the name while the org id is what
 *     gets sent.
 *  2. USER combobox (optional) — appears once a concrete org is chosen. Type a
 *     name/email to search that org's members (server-side, debounced) and pick
 *     one to target the message at a single user. Cleared = the whole org sees it.
 *
 * Both fields are name-display / id-store: the user reads names, the API receives
 * ids. Targeting a specific user is optional and only offered for a concrete org
 * (never for support or broadcast).
 */
export function RecipientPicker({
  supportAlias,
  supportAliases,
  teamOptions,
  recipientOrgId,
  onRecipientOrgIdChange,
  recipientUserId,
  onRecipientUserIdChange,
  fetchMembers,
}: RecipientPickerProps) {
  // Every configured support alias, primary first and labeled "Pipeline Builder
  // Support"; the rest labeled by their alias. Set (lowercased) drives the
  // "is this a support recipient?" check below.
  const aliases = useMemo(() => (supportAliases?.length ? supportAliases : [supportAlias]), [supportAliases, supportAlias]);
  const aliasSet = useMemo(() => new Set(aliases.map((a) => a.toLowerCase())), [aliases]);

  // All selectable teams: the support aliases first, then the caller's teams.
  const allTeams = useMemo<TeamOption[]>(
    () => [
      ...aliases.map((a) => ({ value: a, label: a.toLowerCase() === supportAlias.toLowerCase() ? SUPPORT_LABEL : a })),
      ...teamOptions,
    ],
    [aliases, supportAlias, teamOptions],
  );

  // Display text for the team field. Initialized (once per mount — the modal
  // remounts this component each open) from the current org id: show the friendly
  // label when it maps to a known team/support, else the raw value.
  const [teamText, setTeamText] = useState<string>(() => {
    const match = allTeams.find((t) => t.value.toLowerCase() === recipientOrgId.toLowerCase());
    return match ? match.label : recipientOrgId;
  });

  // Is the current recipient a CONCRETE org (eligible for per-user targeting)?
  // Any support alias, empty, and the '*' broadcast are not.
  const isConcreteOrg = useMemo(() => {
    const v = recipientOrgId.trim().toLowerCase();
    return v !== '' && v !== '*' && !aliasSet.has(v);
  }, [recipientOrgId, aliasSet]);

  // -- Team combobox ---------------------------------------------------------
  const team = useCombobox(setTeamText);

  const resolveOrgId = useCallback(
    (typed: string): string => {
      // An exact (case-insensitive) label match resolves to that team's id;
      // otherwise the typed text is the value (advanced: paste a raw org id).
      const byLabel = allTeams.find((t) => t.label.toLowerCase() === typed.trim().toLowerCase());
      return byLabel ? byLabel.value : typed;
    },
    [allTeams],
  );

  const handleTeamInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const typed = e.target.value;
      team.handleInputChange(e); // sets filter + teamText via setTeamText + opens
      onRecipientOrgIdChange(resolveOrgId(typed));
      // Changing the org invalidates any prior per-user target.
      if (recipientUserId) onRecipientUserIdChange('');
    },
    [team, onRecipientOrgIdChange, resolveOrgId, recipientUserId, onRecipientUserIdChange],
  );

  const handleTeamSelect = useCallback(
    (opt: TeamOption) => {
      setTeamText(opt.label);
      onRecipientOrgIdChange(opt.value);
      if (recipientUserId) onRecipientUserIdChange('');
      team.dismiss();
    },
    [onRecipientOrgIdChange, recipientUserId, onRecipientUserIdChange, team],
  );

  const teamMatches = useMemo(() => {
    const q = (team.filter || teamText).trim().toLowerCase();
    if (!q) return allTeams;
    return allTeams.filter(
      (t) => t.label.toLowerCase().includes(q) || t.value.toLowerCase().includes(q),
    );
  }, [team.filter, teamText, allTeams]);

  // -- User combobox (optional) ---------------------------------------------
  const [userText, setUserText] = useState('');
  const user = useCombobox(setUserText);
  const debouncedUserText = useDebounce(userText, 250);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // When the recipient org changes, clear the per-user picker's local display
  // text + stale member list — they belonged to the previous org. Without this,
  // a username selected for org A lingers in the field after switching to org B
  // (while the parent's recipientUserId was already cleared by the team
  // handlers), silently mis-representing the target.
  useEffect(() => {
    setUserText('');
    setMembers([]);
  }, [recipientOrgId]);

  // Fetch members of the selected org as the user types (debounced). Guarded to
  // concrete orgs and an open dropdown; races resolved by an ignore flag.
  useEffect(() => {
    if (!isConcreteOrg || !user.open) return;
    let ignore = false;
    setLoadingMembers(true);
    fetchMembers(recipientOrgId, debouncedUserText.trim())
      .then((rows) => { if (!ignore) setMembers(rows); })
      .catch(() => { if (!ignore) setMembers([]); })
      .finally(() => { if (!ignore) setLoadingMembers(false); });
    return () => { ignore = true; };
  }, [isConcreteOrg, user.open, recipientOrgId, debouncedUserText, fetchMembers]);

  const handleUserSelect = useCallback(
    (m: MemberOption) => {
      setUserText(m.username);
      onRecipientUserIdChange(m.id);
      user.dismiss();
    },
    [onRecipientUserIdChange, user],
  );

  const clearUser = useCallback(() => {
    setUserText('');
    onRecipientUserIdChange('');
  }, [onRecipientUserIdChange]);

  return (
    <div className="space-y-2">
      {/* Team / org typeahead */}
      <div ref={team.wrapperRef} className="relative">
        <Input
          ref={team.inputRef}
          type="text"
          value={teamText}
          onChange={handleTeamInput}
          onFocus={() => team.setOpen(true)}
          onKeyDown={(e) => team.handleKeyDown(e, teamMatches.length, (i) => handleTeamSelect(teamMatches[i]))}
          placeholder="To: team or organization"
          aria-label="Recipient team or organization"
          autoComplete="off"
          {...team.inputAriaProps}
        />
        {team.open && (
          <div role="listbox" id={team.listboxId} aria-label="Teams" className="absolute z-50 mt-1 w-full max-h-52 overflow-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-lg text-sm">
            {teamMatches.length === 0 ? (
              <div className="px-3 py-2 text-gray-500 dark:text-gray-400">No matching teams — type a full org id to send directly</div>
            ) : (
              teamMatches.map((opt, i) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  id={team.optionId(i)}
                  aria-selected={i === team.activeIndex}
                  ref={(el) => { if (i === team.activeIndex) el?.scrollIntoView({ block: 'nearest' }); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => team.setActiveIndex(i)}
                  onClick={() => handleTeamSelect(opt)}
                  className={`w-full text-left px-3 py-1.5 cursor-pointer text-gray-900 dark:text-gray-100 transition-colors flex items-center gap-2 ${i === team.activeIndex ? 'bg-blue-100 dark:bg-blue-900/40' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
                >
                  <Users className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span className="truncate">{opt.label}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Per-user target (optional) — only for a concrete org */}
      {isConcreteOrg && (
        <div ref={user.wrapperRef} className="relative">
          <div className="relative">
            <Input
              ref={user.inputRef}
              type="text"
              value={userText}
              onChange={user.handleInputChange}
              onFocus={() => user.setOpen(true)}
              onKeyDown={(e) => user.handleKeyDown(e, members.length, (i) => handleUserSelect(members[i]))}
              placeholder="To a specific user (optional) — leave blank for the whole team"
              aria-label="Recipient user (optional)"
              autoComplete="off"
              {...user.inputAriaProps}
            />
            {recipientUserId && (
              <button
                type="button"
                onClick={clearUser}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                aria-label="Clear user target (send to whole team)"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {user.open && (
            <div role="listbox" id={user.listboxId} aria-label="Members" className="absolute z-50 mt-1 w-full max-h-52 overflow-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-lg text-sm">
              {loadingMembers ? (
                <div className="px-3 py-2 text-gray-500 dark:text-gray-400" role="status">Searching members…</div>
              ) : members.length === 0 ? (
                <div className="px-3 py-2 text-gray-500 dark:text-gray-400">
                  {debouncedUserText.trim() ? 'No matching members' : 'Type a name to search, or leave blank for everyone'}
                </div>
              ) : (
                members.map((m, i) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    id={user.optionId(i)}
                    aria-selected={i === user.activeIndex}
                    ref={(el) => { if (i === user.activeIndex) el?.scrollIntoView({ block: 'nearest' }); }}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => user.setActiveIndex(i)}
                    onClick={() => handleUserSelect(m)}
                    className={`w-full text-left px-3 py-1.5 cursor-pointer text-gray-900 dark:text-gray-100 transition-colors flex items-center gap-2 ${i === user.activeIndex ? 'bg-blue-100 dark:bg-blue-900/40' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
                  >
                    <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="truncate font-medium">{m.username}</span>
                    <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 truncate">{m.email}</span>
                  </button>
                ))
              )}
            </div>
          )}
          {recipientUserId && (
            <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
              Only <span className="font-medium">{userText || 'the selected user'}</span> will see this message.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
