import React from "react";
import type { StoreApi } from "zustand";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createZustandContext = <TInitial, TStore extends StoreApi<any>>(
  getStore: (initial: TInitial) => TStore,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Context = React.createContext(null as any as TStore);

  const Provider = (props: {
    children?: React.ReactNode;
    initialValue: TInitial;
  }) => {
    const [store] = React.useState(() => getStore(props.initialValue));

    return <Context.Provider value={store}>{props.children}</Context.Provider>;
  };

  return {
    useContext: () => React.useContext(Context),
    Context,
    Provider,
  };
};
