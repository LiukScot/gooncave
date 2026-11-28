import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';
import { useErrorToast } from '@/lib/useErrorToast';

const NEW_ISSUE = 'https://github.com/LiukScot/gooncave/issues/new';
// GitHub refuses addresses of about 8 KB; this leaves room for the note on removed lines.
const MAX_ADDRESS_LENGTH = 7500;
const DESCRIPTION_HINT = 'What you did, what you expected and what you saw.';

type Report = Awaited<ReturnType<typeof api.getReport>>;

const deviceRows = ({ version, commit, platform, schema }: Report): [string, string][] => [
  ['App version', `${version} (${commit})`],
  ['Platform', platform],
  ['System', navigator.userAgent],
  [
    'Screen',
    `${window.innerWidth}×${window.innerHeight} at ${Number(window.devicePixelRatio.toFixed(2))}x, ${navigator.maxTouchPoints > 0 ? 'touch' : 'no touch'}`
  ],
  ['Database schema', schema]
];

/** Everything in the issue above the log. */
export const reportHead = (report: Report, description: string) =>
  [
    '## What happened',
    '',
    description.trim() || DESCRIPTION_HINT,
    '',
    '## Device',
    '',
    ...deviceRows(report).map(([label, value]) => `- ${label}: ${value}`),
    '',
    '## Background work',
    '',
    ...report.jobs.map((job) => `- ${job}`),
    '',
    '## Latest log'
  ].join('\n');

export const reportBody = (head: string, logLines: string[], note?: string) =>
  [head, '', '```', ...(note ? [note] : []), ...logLines, '```'].join('\n');

const address = (body?: string) => {
  const query = new URLSearchParams({ title: 'Bug report' });
  if (body !== undefined) query.set('body', body);
  return `${NEW_ISSUE}?${query}`;
};

/**
 * The address of a prefilled issue. When the report does not fit in an address, the oldest log
 * lines go first; `removedLines` says how many. `bodyFits` is false when the text above the log
 * alone is too long, and the issue then opens empty.
 */
export const issueAddress = (head: string, log: string) => {
  const lines = log ? log.split('\n') : [];
  const href = (removedLines: number) =>
    address(
      reportBody(
        head,
        lines.slice(removedLines),
        removedLines ? `(${removedLines} older lines left out)` : undefined
      )
    );
  // The page calls this on every typed letter, so the cut is found by halving.
  let removedLines = 0;
  let high = lines.length;
  while (removedLines < high) {
    const middle = Math.floor((removedLines + high) / 2);
    if (href(middle).length <= MAX_ADDRESS_LENGTH) high = middle;
    else removedLines = middle + 1;
  }
  return href(removedLines).length > MAX_ADDRESS_LENGTH
    ? { href: address(), removedLines, bodyFits: false }
    : { href: href(removedLines), removedLines, bodyFits: true };
};

/** Whether the app writes a log at all. */
function LoggingToggle({ enabled }: { enabled: boolean }) {
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: api.setLogging,
    onSuccess: (logging) =>
      client.setQueryData<Report>(queryKeys.report, (report) => report && { ...report, logging })
  });
  useErrorToast(update.error);
  return (
    <div className="list-group self-stretch mb-0">
      <div className="list-group-item flex items-center gap-3">
        <ScrollText className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">
          <label className="block font-medium" htmlFor="report-logging" id="report-log-heading">Logs</label>
          <span className="block text-muted-foreground text-xs">
            Notes errors on this device, so a report shows the cause.
          </span>
        </span>
        <input className="form-check-input shrink-0" type="checkbox" id="report-logging" name="logging"
          checked={enabled} disabled={update.isPending}
          onChange={() => update.mutate(!enabled)} />
      </div>
    </div>
  );
}

export function ReportIssueSettings() {
  const report = useQuery({
    queryKey: queryKeys.report,
    queryFn: api.getReport,
    retry: false,
    staleTime: 0
  });
  const [description, setDescription] = useState('');
  const head = report.data ? reportHead(report.data, description) : '';
  // With logs off the page hides the log, so the issue does not send it either.
  const log = report.data?.logging ? report.data.log : '';
  const issue = useMemo(() => issueAddress(head, log), [head, log]);

  if (report.isPending) {
    return <p className="text-muted-foreground text-sm">Reading the log…</p>;
  }
  if (report.isError) {
    return (
      <div>
        <p className="text-sm mb-2">
          The log cannot be shown right now. {report.error.message} You can still report
          the problem on GitHub by describing it yourself.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-outline-light btn-sm"
            disabled={report.isFetching}
            onClick={() => void report.refetch()}
          >
            {report.isFetching ? 'Reading the log…' : 'Read the log again'}
          </button>
          <a className="btn btn-outline-light btn-sm" href={address()} target="_blank" rel="noreferrer noopener">
            Open an empty GitHub issue
          </a>
        </div>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportBody(head, log ? log.split('\n') : []));
      toast.success('Report copied');
    } catch (error) {
      console.warn('Cannot copy the report', error);
      toast.error('The report could not be copied. Select the text and copy it by hand.');
    }
  };

  return (
    // One gap between sections and one inside them, so every block sits the same distance apart.
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        Nothing leaves this device until you send it. Addresses, file names and quoted text are
        already taken out of the log. The issue opens on GitHub with everything below, and you can
        change any of it there before sending.
      </p>

      <section className="flex flex-col items-start gap-2">
        <label className="font-medium" htmlFor="report-description">
          What happened
        </label>
        <textarea
          className="form-control self-stretch"
          id="report-description"
          name="report-description"
          rows={4}
          placeholder={DESCRIPTION_HINT}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <a className="btn btn-primary btn-sm" href={issue.href} target="_blank" rel="noreferrer noopener">
          Open GitHub issue
        </a>
        <p className="text-muted-foreground text-xs">
          The issue opens in your browser, ready to read and send. Sending needs a GitHub account.
        </p>
        {issue.removedLines > 0 || !issue.bodyFits ? (
          <p className="text-sm">
            {issue.bodyFits
              ? `This report is too long for GitHub's form, so the issue leaves out the ${issue.removedLines} oldest log lines.`
              : "This report is too long for GitHub's form, so the issue opens empty."}{' '}
            To send all of it, use Copy report and paste it into the issue.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Device</h2>
        <dl className="report-block grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {deviceRows(report.data).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words m-0">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Background work</h2>
        <ul className="report-block list-none text-sm">
          {report.data.jobs.map((job) => (
            <li key={job}>{job}</li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col items-start gap-2">
        <LoggingToggle enabled={report.data.logging} />
        {!report.data.logging ? null : (
          <>
            <button type="button" className="btn btn-outline-light btn-sm" onClick={() => void copy()}>
              Copy report
            </button>
            {log ? (
              <pre
                className="report-block report-log font-mono text-xs self-stretch"
                role="region"
                tabIndex={0}
                aria-labelledby="report-log-heading"
              >
                {log}
              </pre>
            ) : (
              <p className="report-block text-muted-foreground text-sm self-stretch">Nothing has gone wrong lately. Suspicious.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
