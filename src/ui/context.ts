import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { AppStore } from "../state/store";

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}
