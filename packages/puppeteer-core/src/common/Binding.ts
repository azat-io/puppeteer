import {isErrorLike} from '../util/ErrorLike.js';
import {ExecutionContext} from './ExecutionContext.js';

/**
 * @internal
 */
export class Binding {
  #name: string;
  #fn: (...args: unknown[]) => unknown;
  constructor(name: string, fn: (...args: unknown[]) => unknown) {
    this.#name = name;
    this.#fn = fn;
  }

  async call(
    context: ExecutionContext,
    seq: number,
    args: unknown[]
  ): Promise<void> {
    try {
      // Getting non-trivial arguments.
      const handles = await context.evaluateHandle(
        (name, seq) => {
          // @ts-expect-error Code is evaluated in a different context.
          return globalThis[name].args.get(seq);
        },
        this.#name,
        seq
      );
      try {
        const properties = await handles.getProperties();
        for (const [index, handle] of properties) {
          // This is not straight-forward since some arguments can stringify, but
          // aren't plain objects so add subtypes when the use-case arises.
          if (index in args) {
            switch (handle.remoteObject().subtype) {
              case 'node':
                args[+index] = handle;
                break;
            }
          }
        }

        try {
          await context.evaluate(
            (name, seq, result) => {
              // @ts-expect-error Code is evaluated in a different context.
              const callbacks = globalThis[name].callbacks;
              callbacks.get(seq).resolve(result);
              callbacks.delete(seq);
            },
            this.#name,
            seq,
            await this.#fn(...args)
          );
        } finally {
          for (const [, handle] of properties) {
            await handle.dispose();
          }
        }
      } finally {
        await handles.dispose();
      }
    } catch (error) {
      if (isErrorLike(error)) {
        // The WaitTask may already have been resolved by timing out, or the
        // execution context may have been destroyed.
        // In both caes, the promises above are rejected with a protocol error.
        // We can safely ignores these, as the WaitTask is re-installed in
        // the next execution context if needed.
        if (error.message.includes('Protocol error')) {
          return;
        }
        await context.evaluate(
          (name, seq, message, stack) => {
            const error = new Error(message);
            error.stack = stack;
            // @ts-expect-error Code is evaluated in a different context.
            const callbacks = globalThis[name].callbacks;
            callbacks.get(seq).reject(error);
            callbacks.delete(seq);
          },
          this.#name,
          seq,
          error.message,
          error.stack
        );
      } else {
        await context.evaluate(
          (name, seq, error) => {
            // @ts-expect-error Code is evaluated in a different context.
            const callbacks = globalThis[name].callbacks;
            callbacks.get(seq).reject(error);
            callbacks.delete(seq);
          },
          this.#name,
          seq,
          error
        );
      }
    }
  }
}
