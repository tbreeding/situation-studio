export type OperationsEvidenceItem = {
  id: string;
  subject: string;
  state: string;
  diagnosticCode: string | null;
  detail: string;
  recordedAtLabel: string;
};

function EvidenceList({
  emptyMessage,
  items,
}: {
  emptyMessage: string;
  items: OperationsEvidenceItem[];
}) {
  if (!items.length)
    return (
      <div className="emptyState">
        <strong>{emptyMessage}</strong>
      </div>
    );

  return (
    <div className="operationsEvidenceList">
      {items.map((item) => (
        <article key={item.id}>
          <div className="operationsEvidenceHeading">
            <div>
              <strong>{item.subject}</strong>
              <code>{item.id}</code>
            </div>
            <span>{item.state.toLowerCase().replaceAll("_", " ")}</span>
          </div>
          <p>{item.detail}</p>
          <footer>
            <span>{item.recordedAtLabel}</span>
            {item.diagnosticCode ? <code>{item.diagnosticCode}</code> : null}
          </footer>
        </article>
      ))}
    </div>
  );
}

export function OperationsEvidence({
  publications,
  backups,
}: {
  publications: OperationsEvidenceItem[];
  backups: OperationsEvidenceItem[];
}) {
  return (
    <section
      className="operationsEvidenceGrid"
      aria-label="Recent operational evidence"
    >
      <section className="operationsCard">
        <header>
          <div>
            <p className="cardEyebrow">Publisher receipts</p>
            <h2>Recent non-success outcomes</h2>
          </div>
          <span>{publications.length} shown</span>
        </header>
        <EvidenceList
          emptyMessage="No failed, restored, or recovery-required publications."
          items={publications}
        />
      </section>
      <section className="operationsCard">
        <header>
          <div>
            <p className="cardEyebrow">Backup receipts</p>
            <h2>Recent backup attempts</h2>
          </div>
          <span>{backups.length} shown</span>
        </header>
        <EvidenceList
          emptyMessage="No backup receipts have been recorded."
          items={backups}
        />
      </section>
    </section>
  );
}
