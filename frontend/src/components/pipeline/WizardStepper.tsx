import { Check } from 'lucide-react';

export interface WizardStep {
  label: string;
  shortLabel?: string;
}

interface WizardStepperProps {
  steps: readonly WizardStep[];
  currentStep: number;
  onStepClick?: (index: number) => void;
  stepStatus?: Record<number, 'valid' | 'error' | 'untouched'>;
}

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
