export class RingBuffer<T> {
  readonly capacity: number;
  dropped = 0;
  private items: T[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }
}
