// The word count in the status bar. With a selection it reads "120 of 2,340
// words", as in Word.

export function wordCountLabel(total: number, selected: number | null): string {
  const unit = total === 1 ? "word" : "words";
  if (selected !== null && selected > 0) return `${selected.toLocaleString()} of ${total.toLocaleString()} ${unit}`;
  return `${total.toLocaleString()} ${unit}`;
}
