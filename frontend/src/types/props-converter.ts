/**
 * @module props-converter
 * @description Bidirectional conversion between BuilderProps (API) and FormBuilderState (UI).
 *
 * Re-exports from focused modules:
 * - props-parsing:    BuilderProps → FormBuilderState (for edit mode)
 * - props-validation: FormBuilderState → validation errors
 * - props-assembly:   FormBuilderState → BuilderProps (for create/update)
 */

export { propsToFormState } from './props-parsing';
export { validateFormState } from './props-validation';
export { assembleBuilderProps } from './props-assembly';
