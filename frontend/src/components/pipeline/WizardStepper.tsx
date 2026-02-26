import { Check } from 'lucide-react';

/** Describes a single step in the wizard. */
export interface WizardStep {
  /** Full label displayed on larger screens. */
  label: string;
  /** Abbreviated label displayed on small screens (falls back to label). */
  shortLabel?: string;
}

/** Props for {@link WizardStepper}. */
interface WizardStepperProps {
  /** Ordered list of wizard step definitions. */
  steps: readonly WizardStep[];
  /** Zero-based index of the currently active step. */
  currentStep: number;
  /** Callback when the user clicks a step circle (only fires for clickable steps). */
  onStepClick?: (index: number) => void;
  /** Validation status for each step, keyed by step index. */
  stepStatus?: Record<number, 'valid' | 'error' | 'untouched'>;
}

/**
 * Horizontal step indicator for the pipeline creation/edit wizard.
 *
 * Renders numbered circles connected by lines, with color-coded status
 * (current, valid, error, untouched). Completed valid steps show a checkmark.
 * Steps can be clicked to navigate back to previously visited steps.
 */
export default function WizardStepper({ steps, currentStep, onStepClick, stepStatus = {} }: WizardStepperProps) {
  return (
    <nav className="flex items-center justify-center" aria-label="Wizard progress">
      {steps.map((step, index) => {
        const status = stepStatus[index] ?? 'untouched';
        const isCurrent = index === currentStep;
        const isCompleted = index < currentStep;
        const isClickable = onStepClick && (isCompleted || status !== 'untouched');

        return (
          <div key={index} className="flex items-center">
            {/* Connector line (before all steps except first) */}
            {index > 0 && (
              <div
                className={`w-12 sm:w-20 h-0.5 ${
                  index <= currentStep
                    ? 'bg-blue-500 dark:bg-blue-400'
                    : 'bg-gray-300 dark:bg-gray-600'
                }`}
              />
            )}

            {/* Step circle + label */}
            <button
              type="button"
              onClick={() => isClickable && onStepClick?.(index)}
              disabled={!isClickable}
              className="flex flex-col items-center group"
              aria-current={isCurrent ? 'step' : undefined}
            >
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'bg-blue-600 text-white ring-2 ring-blue-200 dark:ring-blue-800'
                    : isCompleted && status === 'valid'
                    ? 'bg-green-600 text-white'
                    : isCompleted && status === 'error'
                    ? 'bg-red-500 text-white'
                    : status === 'error'
                    ? 'bg-red-500 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                } ${isClickable ? 'cursor-pointer hover:ring-2 hover:ring-blue-300 dark:hover:ring-blue-700' : 'cursor-default'}`}
              >
                {isCompleted && status === 'valid' ? (
                  <Check className="w-4 h-4" />
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={`mt-1.5 text-xs font-medium whitespace-nowrap ${
                  isCurrent
                    ? 'text-blue-600 dark:text-blue-400'
                    : isCompleted
                    ? 'text-gray-700 dark:text-gray-300'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <span className="hidden sm:inline">{step.label}</span>
                <span className="sm:hidden">{step.shortLabel ?? step.label}</span>
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
