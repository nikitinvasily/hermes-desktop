import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../components/useI18n";

type Target = Awaited<
  ReturnType<typeof window.hermesAPI.getProfileEditorTarget>
>;
type Run = Awaited<
  ReturnType<typeof window.hermesAPI.listCronRuns>
>["runs"][number];
type Output = Awaited<ReturnType<typeof window.hermesAPI.getCronRunOutput>>;

/** Cron endpoints return epoch seconds or ISO strings. */
function formatRunTime(value: Run["started_at"]): string {
  if (value === null || value === "") return "--";
  const date =
    typeof value === "number"
      ? new Date(value < 1e12 ? value * 1000 : value)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function CronRunHistory(props: {
  jobId: string;
  profile?: string;
  connectionId?: string;
  capturedTarget?: Target;
  refreshRevision?: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const generation = useRef(0);
  const alive = useRef(true);
  const scope = JSON.stringify([
    props.jobId,
    props.profile,
    props.connectionId,
  ]);
  const currentScope = useRef(scope);
  const currentRefresh = useRef(props.refreshRevision);
  currentRefresh.current = props.refreshRevision;
  const selection = useRef<{ scope: string; runId: string | null } | null>(
    null,
  );
  if (currentScope.current !== scope) {
    currentScope.current = scope;
    selection.current = null;
  }
  const rememberSelection = useCallback(
    (runId: string | null) => {
      selection.current = { scope, runId };
    },
    [scope],
  );
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => {
    // Invalidate synchronously, before React commits the keyed replacement.
    generation.current += 1;
    setRevision(generation.current);
  }, []);
  const isCurrent = useCallback(
    () =>
      alive.current &&
      generation.current === revision &&
      currentScope.current === scope &&
      currentRefresh.current === props.refreshRevision,
    [revision, scope, props.refreshRevision],
  );
  useEffect(() => {
    alive.current = true;
    const unsubscribe = props.capturedTarget
      ? () => {}
      : window.hermesAPI.onConnectionConfigChanged(() => {
          // Auth/config can change without a connection ID change. Never retain
          // rows, output or selection from a previously issued target snapshot.
          selection.current = null;
          reload();
        });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [reload, props.capturedTarget]);
  return (
    <section className="schedules-history" aria-label={t("schedules.history")}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={reload}
      >
        {t("schedules.historyRefresh")}
      </button>
      <ScopedCronRunHistory
        key={JSON.stringify([scope, revision, props.refreshRevision])}
        {...props}
        isCurrent={isCurrent}
        initialRun={
          selection.current?.scope === scope ? selection.current.runId : null
        }
        onSelection={rememberSelection}
      />
    </section>
  );
}

function ScopedCronRunHistory({
  jobId,
  profile,
  connectionId,
  isCurrent,
  initialRun,
  onSelection,
  capturedTarget,
}: {
  jobId: string;
  profile?: string;
  connectionId?: string;
  capturedTarget?: Target;
  isCurrent: () => boolean;
  initialRun: string | null;
  onSelection: (runId: string | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [target, setTarget] = useState<Target | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState("");
  const [selectedRun, setOpenRun] = useState<string | null>(initialRun);
  const openRun = runs?.some((run) => run.id === selectedRun)
    ? selectedRun
    : null;
  const [outputReply, setOutput] = useState<{
    runId: string;
    result: Output;
  } | null>(null);
  // Effects run after commit: tag the reply so switching rows cannot paint
  // the previous run's output even for one frame before the effect clears it.
  const output = outputReply?.runId === openRun ? outputReply.result : null;
  useEffect(() => {
    let cancelled = false;
    void (
      capturedTarget
        ? Promise.resolve(capturedTarget)
        : window.hermesAPI.getProfileEditorTarget(
            profile || "default",
            connectionId,
          )
    )
      .then(async (next: Target) => {
        if (cancelled || !isCurrent()) return;
        setTarget(next);
        const result = await window.hermesAPI.listCronRuns(
          jobId,
          20,
          next.profile,
          next,
        );
        if (!cancelled && isCurrent()) {
          if (result.success) {
            if (
              initialRun &&
              !result.runs.some((run) => run.id === initialRun)
            ) {
              onSelection(null);
              setOpenRun(null);
            }
            setRuns(result.runs);
          } else
            setError(
              result.unsupported
                ? t("schedules.historyUnsupported")
                : result.error || t("schedules.historyLoadFailed"),
            );
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && isCurrent())
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [
    jobId,
    profile,
    connectionId,
    capturedTarget,
    isCurrent,
    initialRun,
    onSelection,
    t,
  ]);
  useEffect(() => {
    let cancelled = false;
    setOutput(null);
    if (!openRun || !target) return;
    void window.hermesAPI
      .getCronRunOutput(jobId, openRun, target.profile, target)
      .then((result) => {
        if (!cancelled && isCurrent()) setOutput({ runId: openRun, result });
      })
      .catch((reason: unknown) => {
        if (!cancelled && isCurrent())
          setOutput({
            runId: openRun,
            result: {
              success: false,
              output: "",
              error: reason instanceof Error ? reason.message : String(reason),
            },
          });
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, openRun, target, isCurrent]);
  if (error)
    return (
      <div className="schedules-card-error" role="alert">
        {error}
      </div>
    );
  if (runs === null)
    return <div role="status">{t("schedules.historyLoading")}</div>;
  if (runs.length === 0) return <div>{t("schedules.historyEmpty")}</div>;
  return (
    <div>
      {runs.map((run) => (
        <div key={run.id} className="schedules-history-run">
          <button
            type="button"
            className="schedules-history-row"
            aria-expanded={openRun === run.id}
            onClick={() => {
              if (!isCurrent()) return;
              const next = openRun === run.id ? null : run.id;
              onSelection(next);
              setOpenRun(next);
            }}
          >
            <span>{formatRunTime(run.started_at)}</span>
            {run.is_active && (
              <span aria-label={t("schedules.historyRunning")}>●</span>
            )}
            <span className="schedules-history-preview">
              {run.preview || run.title}
            </span>
            <span>{`↑${run.input_tokens ?? 0} ↓${run.output_tokens ?? 0}`}</span>
          </button>
          {openRun === run.id && (
            <div
              className="schedules-history-output"
              role="region"
              aria-label={t("schedules.historyRunOutput")}
            >
              {output?.success ? (
                <>
                  {output.partial && (
                    <div className="schedules-field-hint">
                      {t("schedules.historyOutputPartial")}
                    </div>
                  )}
                  <pre>{output.output}</pre>
                  {output.truncated && (
                    <div className="schedules-field-hint">
                      {t("schedules.historyOutputTruncated")}
                    </div>
                  )}
                </>
              ) : output ? (
                <div className="schedules-card-error">
                  {output.unsupported
                    ? t("schedules.historyUnsupported")
                    : output.error || t("schedules.historyOutputFailed")}
                </div>
              ) : (
                t("schedules.historyLoading")
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
