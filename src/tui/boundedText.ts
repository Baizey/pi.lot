export const defaultTruncationNotice = "[truncated]";

export enum TextRetention {
  HEAD = "head",
  TAIL = "tail",
}

/** Accumulates a bounded text stream without retaining discarded chunks. */
export class BoundedTextBuffer {
  private text = "";
  private truncated = false;
  private readonly capacity: number;

  constructor(
    maxCharacters: number,
    private readonly truncationNotice = defaultTruncationNotice,
    private readonly retention: TextRetention = TextRetention.HEAD,
  ) {
    this.capacity = characterLimit(maxCharacters);
  }

  append(chunk: string): void {
    if (!chunk) return;
    if (this.retention === TextRetention.TAIL) {
      const combined = this.text + chunk;
      this.truncated ||= combined.length > this.capacity;
      this.text = this.capacity === 0 ? "" : combined.slice(-this.capacity);
      return;
    }

    const remaining = Math.max(0, this.capacity - this.text.length);
    this.text += chunk.slice(0, remaining);
    if (chunk.length > remaining) this.truncated = true;
  }

  content(): string {
    return this.text;
  }

  value(): string {
    if (!this.truncated) return this.text;
    return this.retention === "tail"
      ? `${this.truncationNotice}\n${this.text}`
      : `${this.text}\n${this.truncationNotice}`;
  }

  wasTruncated(): boolean {
    return this.truncated;
  }
}

export function truncateText(
  value: string,
  maxCharacters: number,
  truncationNotice = defaultTruncationNotice,
): string {
  const capacity = characterLimit(maxCharacters);
  if (value.length <= capacity) return value;
  return `${value.slice(0, capacity)}\n${truncationNotice}`;
}

function characterLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
