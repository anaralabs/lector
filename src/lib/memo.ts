export const firstMemo = <T>(
  first: boolean,
  memo: unknown,
  initializer: () => T,
): T => {
  if (!first && !memo) {
    throw new Error(
      "Missing memo initialization. You likely forgot to return the result of `firstMemo` in the event function",
    );
  }

  if (first) {
    return initializer();
  }

  return memo! as T;
};
