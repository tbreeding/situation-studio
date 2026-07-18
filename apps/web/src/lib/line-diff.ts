export type DiffLineKind = "unchanged" | "removed" | "added" | "empty";

export type DiffLine = {
  kind: DiffLineKind;
  number: number | null;
  text: string;
};

export type LineDiffRow = {
  left: DiffLine;
  right: DiffLine;
};

type Operation = {
  kind: "unchanged" | "removed" | "added";
  number: number;
  rightNumber?: number;
  text: string;
};

function lines(value: string): string[] {
  return value.split("\n");
}

export function buildLineDiff(original: string, candidate: string) {
  const leftLines = lines(original);
  const rightLines = lines(candidate);
  const table = Array.from(
    { length: leftLines.length + 1 },
    () => new Uint32Array(rightLines.length + 1),
  );

  for (let left = leftLines.length - 1; left >= 0; left -= 1) {
    for (let right = rightLines.length - 1; right >= 0; right -= 1) {
      const diagonal = table[left + 1]?.[right + 1] ?? 0;
      const below = table[left + 1]?.[right] ?? 0;
      const beside = table[left]?.[right + 1] ?? 0;
      const row = table[left];
      if (row)
        row[right] =
          leftLines[left] === rightLines[right]
            ? diagonal + 1
            : Math.max(below, beside);
    }
  }

  const operations: Operation[] = [];
  let left = 0;
  let right = 0;
  while (left < leftLines.length && right < rightLines.length) {
    if (leftLines[left] === rightLines[right]) {
      operations.push({
        kind: "unchanged",
        number: left + 1,
        rightNumber: right + 1,
        text: leftLines[left] ?? "",
      });
      left += 1;
      right += 1;
    } else if (
      (table[left + 1]?.[right] ?? 0) >= (table[left]?.[right + 1] ?? 0)
    ) {
      operations.push({
        kind: "removed",
        number: left + 1,
        text: leftLines[left] ?? "",
      });
      left += 1;
    } else {
      operations.push({
        kind: "added",
        number: right + 1,
        text: rightLines[right] ?? "",
      });
      right += 1;
    }
  }
  while (left < leftLines.length) {
    operations.push({
      kind: "removed",
      number: left + 1,
      text: leftLines[left] ?? "",
    });
    left += 1;
  }
  while (right < rightLines.length) {
    operations.push({
      kind: "added",
      number: right + 1,
      text: rightLines[right] ?? "",
    });
    right += 1;
  }

  const rows: LineDiffRow[] = [];
  let operationIndex = 0;
  let addedCount = 0;
  let removedCount = 0;
  while (operationIndex < operations.length) {
    const operation = operations[operationIndex];
    if (!operation) break;
    if (operation.kind === "unchanged") {
      rows.push({
        left: {
          kind: "unchanged",
          number: operation.number,
          text: operation.text,
        },
        right: {
          kind: "unchanged",
          number: operation.rightNumber ?? null,
          text: operation.text,
        },
      });
      operationIndex += 1;
      continue;
    }

    const removed: Operation[] = [];
    const added: Operation[] = [];
    while (
      operationIndex < operations.length &&
      operations[operationIndex]?.kind !== "unchanged"
    ) {
      const changed = operations[operationIndex];
      if (!changed) break;
      if (changed.kind === "removed") removed.push(changed);
      else added.push(changed);
      operationIndex += 1;
    }
    removedCount += removed.length;
    addedCount += added.length;
    for (
      let changeIndex = 0;
      changeIndex < Math.max(removed.length, added.length);
      changeIndex += 1
    ) {
      rows.push({
        left: removed[changeIndex] ?? {
          kind: "empty",
          number: null,
          text: "",
        },
        right: added[changeIndex] ?? {
          kind: "empty",
          number: null,
          text: "",
        },
      });
    }
  }

  return { addedCount, removedCount, rows };
}
