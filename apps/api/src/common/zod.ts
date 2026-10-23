import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/** Validates a request body/query with a shared Zod schema. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

/**
 * A name shown in lists and written into files (exports, the SQL export's comments): one line,
 * no control characters, trimmed.
 */
export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\u2028\u2029]*$/u, 'Use a single line without control characters');
