export interface IdGenerator {
  uuid(): string;
}

export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return crypto.randomUUID();
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private next = 0;

  constructor(private readonly prefix = "test") {}

  uuid(): string {
    this.next += 1;
    return `${this.prefix}-${this.next}`;
  }
}
