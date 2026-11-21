import { formKey, formRows, type Form, type FormAction } from "./form.ts";
import { pickerKey, pickerRows, type Picker } from "./picker.ts";

/** What takes the place of the input line for a while (a picker, a form); the newest one gets the keys. */
export interface Overlay {
  rows(cols: number, maxRows: number): { rows: string[]; cursor?: [number, number] };
  key(key: string): void;
}

export const pickerOverlay = (picker: Picker, on: (result: NonNullable<ReturnType<typeof pickerKey>>) => void): Overlay => ({
  rows: (cols, maxRows) => ({ rows: pickerRows(picker, cols, maxRows) }),
  key: (key) => {
    const result = pickerKey(picker, key);
    if (result) on(result);
  },
});

export const formOverlay = (form: Form, on: (action: NonNullable<FormAction>) => void): Overlay => ({
  rows: (cols) => formRows(form, cols),
  key: (key) => {
    const action = formKey(form, key);
    if (action) on(action);
  },
});
