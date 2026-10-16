import { useEffect, useRef, useState } from "react";

export function useFileQuery<T>(scope: string, query: string, run: (query: string) => Promise<T>) {
  const [result, setResult] = useState<{ scope: string; query: string; value: T } | null>(null);
  const [pending, setPending] = useState(false);
  const [settled, setSettled] = useState("");
  const runRef = useRef(run);
  const needle = query.trim();
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    if (!needle || !scope) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setPending(true);
      void runRef
        .current(needle)
        .then((value) => {
          if (live) setResult({ scope, query: needle, value });
        })
        .catch(() => {
          if (live) setSettled(`${scope}\n${needle}`);
        })
        .finally(() => {
          if (live) setPending(false);
        });
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [needle, scope]);

  const current = result?.query === needle && result.scope === scope;
  return {
    active: needle.length > 0,
    searching: needle.length > 0 && settled !== `${scope}\n${needle}` && (pending || !current),
    result: current && result ? result.value : null,
  };
}
