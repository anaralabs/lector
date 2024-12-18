export const cancellable = <T extends Promise<unknown>>(
  promise: T,
): {
  promise: T;
  cancel: () => void;
} => {
  let isCancelled = false;

  const wrappedPromise = new Promise((resolve, reject) => {
    promise.then(
      (value) => {
        if (!isCancelled) {
          resolve(value);
        }
      },
      (error) => {
        if (!isCancelled) {
          reject(error);
        }
      },
    );
  }) as unknown as T;

  return {
    promise: wrappedPromise,
    cancel() {
      isCancelled = true;
    },
  };
};
