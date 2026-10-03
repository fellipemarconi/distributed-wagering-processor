import { Injectable } from '@nestjs/common';
import { Clock, IdGenerator } from '../application/ports';

/** UUID v7: ordenado por tempo, então inserts caem no fim do índice da PK. */
@Injectable()
export class UuidV7IdGenerator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
