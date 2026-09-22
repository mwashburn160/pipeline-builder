// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FormBuilderTabRef } from '@/components/pipeline/FormBuilderTab';
import type { BuilderProps } from '@/types';
import { formatError, formatJSON } from '@/lib/constants';

/** The JSON view of the builder's props: shown read-only, or edited and applied back. */
export interface BuilderJsonPreview {
  json: string | null;
  open: boolean;
  error: string | null;
  applied: boolean;
  /** Open the panel on `props`; false (and nothing opens) when there are none. */
  show: (props: BuilderProps | null) => boolean;
  close: () => void;
  /** An edit in the textarea; clears the previous apply result. */
  setJson: (json: string) => void;
  /**
   * Feed the edited JSON through the form's own props → form conversion, then
   * re-render the JSON from the normalized form so the two stay in sync.
   */
  apply: () => void;
}

/**
 * Step navigation and JSON preview shared by the pipeline create / edit and
 * template edit modals. Moving between steps asks the builder first
 * (`canProceed`), keeps the builder's own step in lockstep, and scrolls the
 * modal body (`scrollRef`) back to the top.
 */
export function useBuilderWizard(formRef: RefObject<FormBuilderTabRef | null>) {
  const [currentStep, setCurrentStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [json, setJsonState] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentStep]);

  const next = useCallback(() => {
    if (!formRef.current?.canProceed()) return;
    const step = currentStep + 1;
    setCurrentStep(step);
    formRef.current.goToStep(step);
  }, [currentStep, formRef]);

  const prev = useCallback(() => {
    if (currentStep === 0) return;
    const step = currentStep - 1;
    setCurrentStep(step);
    formRef.current?.goToStep(step);
  }, [currentStep, formRef]);

  /** Back to step one with the preview closed (a new subject, or a reopened modal). */
  const reset = useCallback(() => {
    setCurrentStep(0);
    setOpen(false);
    setJsonState(null);
    setError(null);
    setApplied(false);
  }, []);

  const show = useCallback((props: BuilderProps | null) => {
    setError(null);
    setApplied(false);
    if (!props) return false;
    setJsonState(formatJSON(props));
    setOpen(true);
    return true;
  }, []);

  const setJson = useCallback((value: string) => {
    setJsonState(value);
    setError(null);
    setApplied(false);
  }, []);

  const apply = useCallback(() => {
    setError(null);
    setApplied(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json ?? '');
    } catch (err) {
      setError(`Invalid JSON: ${formatError(err)}`);
      return;
    }
    const form = formRef.current;
    if (!form) {
      setError('Form not ready');
      return;
    }
    // loadFromProps returns an error string on failure, null on success.
    const loadError = form.loadFromProps(parsed);
    if (loadError) {
      setError(loadError);
      return;
    }
    const normalized = form.getPropsPreview();
    if (normalized) setJsonState(formatJSON(normalized));
    setApplied(true);
  }, [json, formRef]);

  const preview: BuilderJsonPreview = {
    json, open, error, applied, show, close: () => setOpen(false), setJson, apply,
  };

  return { currentStep, setCurrentStep, next, prev, reset, scrollRef, preview };
}
