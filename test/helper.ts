export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const createTask =
  <T>(value: T, ms: number): (() => Promise<T>) =>
  () =>
    delay(ms).then(() => value);

export const createFailingTask =
  (error: Error, ms: number): (() => Promise<never>) =>
  () =>
    delay(ms).then(() => {
      throw error;
    });
