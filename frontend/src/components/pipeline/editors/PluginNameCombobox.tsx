import { useState, useCallback } from 'react';
import { Input } from '@/components/ui/Input';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { ShadowingNotice } from '@/components/plugin-installs/ShadowingNotice';
import { usePlugins, usePluginCatalog, groupPlugins } from '@/hooks/usePlugins';
import { useCombobox } from '@/hooks/useCombobox';
import { groupCatalogEntries, shadowedListing, type PluginPick } from '@/lib/plugin-installs';

/** Props for {@link PluginNameCombobox}. */
interface PluginNameComboboxProps {
  /** Current plugin name value. */
  value: string;
  /** Publisher of the current reference ('' / undefined = unqualified). Shown as a prefix. */
  publisher?: string;
  /** Called when the text input value changes (typed or cleared). */
  onChange: (name: string) => void;
  /**
   * Called when an option is picked: an own-org plugin row, or a catalog
   * listing (write `entry.reference` — `{ publisher?, name }` — into the step).
   */
  onSelectPlugin: (pick: PluginPick) => void;
  /** Whether the input is disabled. */
  disabled?: boolean;
  /** Label text shown above the input. */
  label?: string;
  /** Validation error message displayed below the input. */
  error?: string;
}

type Option = { key: string; pick: PluginPick };

/**
 * Autocomplete combobox for selecting a plugin.
 *
 * Offers the org's OWN plugins (grouped by category) and the catalog listings
 * this org can resolve — installed or implicitly installed Official ones —
 * with their publisher and trust tier. After W2 the Official catalog is no
 * longer in `GET /plugins`; it reaches the editor only as listings.
 *
 * Both lists load lazily on first focus. An unqualified name that an own plugin
 * shadows over an Official listing gets the shadowing warning under the input.
 */
export default function PluginNameCombobox({
  value, publisher, onChange, onSelectPlugin, disabled, label = 'Plugin', error,
}: PluginNameComboboxProps) {
  const { open, setOpen, filter, activeIndex, setActiveIndex, wrapperRef, inputRef, handleInputChange, handleKeyDown, dismiss, listboxId, optionId, inputAriaProps } = useCombobox(onChange);

  const [hasOpened, setHasOpened] = useState(false);
  const { plugins, isLoading } = usePlugins(hasOpened);
  // The shadowing report drives a warning on an EXISTING value, so the catalog
  // loads as soon as there is an unqualified name to check, not only on focus.
  const { entries, shadowing, isLoading: catalogLoading } = usePluginCatalog(hasOpened || (!!value && !publisher));

  const handleSelect = useCallback((pick: PluginPick) => {
    onChange(pick.kind === 'plugin' ? pick.plugin.name : pick.entry.reference.name);
    onSelectPlugin(pick);
    dismiss();
  }, [onChange, onSelectPlugin, dismiss]);

  const handleFocus = useCallback(() => {
    setHasOpened(true);
    setOpen(true);
  }, [setOpen]);

  const query = filter || value;
  const pluginGroups = groupPlugins(plugins, query);
  const listingGroups = groupCatalogEntries(entries, query);
  const groups: Array<{ label: string; options: Option[] }> = [
    ...pluginGroups.map((g) => ({
      label: g.category,
      options: g.plugins.map((plugin): Option => ({ key: `p:${plugin.id}`, pick: { kind: 'plugin', plugin } })),
    })),
    ...listingGroups.map((g) => ({
      label: g.label,
      options: g.entries.map((entry): Option => ({ key: `l:${entry.listing.id}`, pick: { kind: 'listing', entry } })),
    })),
  ];
  // Flat, render-ordered option list so keyboard nav can track a single active index across groups.
  const flat = groups.flatMap((g) => g.options);
  const loading = (isLoading || catalogLoading) && flat.length === 0;
  const shadowed = shadowedListing({ publisher, name: value }, shadowing);

  return (
    <div>
      <label className="label">{label} Name *</label>
      <div ref={wrapperRef} className="relative">
        <div className="flex items-center gap-2">
          {publisher && (
            <span className="shrink-0 rounded border border-default bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-fg-muted" title="Publisher">
              {publisher}/
            </span>
          )}
          <Input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onKeyDown={(e) => handleKeyDown(e, flat.length, (i) => handleSelect(flat[i].pick))}
            placeholder="plugin-name (type or select)"
            disabled={disabled}
            autoComplete="off"
            {...inputAriaProps}
          />
        </div>
        {open && !disabled && (
          <div role="listbox" id={listboxId} aria-label="Plugins" className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-surface border border-default rounded-xl shadow-lg text-sm">
            {loading ? (
              <div className="px-3 py-2 text-fg-muted">Loading plugins...</div>
            ) : groups.length === 0 ? (
              <div className="px-3 py-2 text-fg-muted">
                {query ? 'No matching plugins' : 'No plugins available'}
              </div>
            ) : (
              (() => {
                let flatIndex = -1;
                return groups.map((group) => (
                  <div key={group.label}>
                    <div className="px-3 py-1 text-xs font-semibold text-fg-muted bg-canvas sticky top-0">
                      {group.label}
                    </div>
                    {group.options.map((opt) => {
                      flatIndex += 1;
                      const i = flatIndex;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          role="option"
                          id={optionId(i)}
                          aria-selected={i === activeIndex}
                          ref={(el) => { if (i === activeIndex) el?.scrollIntoView({ block: 'nearest' }); }}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => handleSelect(opt.pick)}
                          className={`w-full text-left px-3 py-1.5 cursor-pointer text-fg transition-colors ${i === activeIndex ? 'bg-info-bg' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
                        >
                          <OptionBody pick={opt.pick} />
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            )}
          </div>
        )}
      </div>
      {shadowed && <ShadowingNotice name={shadowed.name} publisher={shadowed.publisherHandle} compact />}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function OptionBody({ pick }: { pick: PluginPick }) {
  if (pick.kind === 'plugin') {
    const { plugin } = pick;
    return (
      <>
        <div className="flex justify-between items-center">
          <span className="truncate font-medium">{plugin.name}</span>
          <span className="ml-2 text-xs text-fg-subtle shrink-0">v{plugin.version}</span>
        </div>
        {plugin.description && <div className="text-xs text-fg-muted truncate">{plugin.description}</div>}
      </>
    );
  }
  const { listing, reference, resolved } = pick.entry;
  return (
    <>
      <div className="flex justify-between items-center gap-2">
        <span className="truncate font-medium">
          {reference.publisher && <span className="font-normal text-fg-muted">{reference.publisher}/</span>}
          {listing.name}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <TrustTierBadge tier={listing.publisherTier} compact />
          {resolved && <span className="text-xs text-fg-subtle">v{resolved.version}</span>}
        </span>
      </div>
      <div className="text-xs text-fg-muted truncate">
        {listing.publisherDisplayName}{(resolved?.description ?? listing.summary) ? ` · ${resolved?.description ?? listing.summary}` : ''}
      </div>
    </>
  );
}
