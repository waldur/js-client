import type { Options } from './client';
import type { RequestResult } from './client';

export type ExtractData<T> = T extends Record<string, unknown> ? T[keyof T] : T;
export type ExtractModel<T> = T extends Array<infer U> ? U : T;

// The universal wrapper that enforces ThrowOnError = true globally
type MapArgs<TArgs extends any[]> = {
    [K in keyof TArgs]: K extends '0' ? (
        Omit<NonNullable<TArgs[0]>, 'throwOnError'> & { throwOnError?: true } | Extract<TArgs[0], undefined>
    ) : TArgs[K]
};

type MapSparseArgs<TArgs extends any[], TData, TField> = {
    [K in keyof TArgs]: K extends '0' ? (
        Omit<NonNullable<TArgs[0]>, 'query' | 'throwOnError'> & {
            query?: Omit<TData extends { query?: infer Q } ? NonNullable<Q> : {}, 'field'> & { field?: TField },
            throwOnError?: true
        } | Extract<TArgs[0], undefined>
    ) : TArgs[K]
};

export type DynamicHeyApiFunc<TData, TRes, TErr, TFunc extends (...args: any) => any> =
    TData extends { query?: infer Q }
        ? ('field' extends keyof NonNullable<Q>
            ? <const TField extends ReadonlyArray<keyof ExtractModel<ExtractData<TRes>>> | never = never>(
                ...args: MapSparseArgs<Parameters<TFunc>, TData, TField>
            ) => Promise<
                [TField] extends [never]
                    ? Awaited<RequestResult<TRes, TErr, true, "fields">>
                    : Omit<Awaited<RequestResult<TRes, TErr, true, "fields">>, 'data'> & {
                        data: ExtractData<TRes> extends Array<any>
                            ? Array<Pick<ExtractModel<ExtractData<TRes>>, Extract<TField[number], keyof ExtractModel<ExtractData<TRes>>>>>
                            : Pick<ExtractModel<ExtractData<TRes>>, Extract<TField[number], keyof ExtractModel<ExtractData<TRes>>>>
                      }
            >
            : (...args: MapArgs<Parameters<TFunc>>) => Promise<Awaited<RequestResult<TRes, TErr, true, "fields">>>)
        : (...args: MapArgs<Parameters<TFunc>>) => Promise<Awaited<RequestResult<TRes, TErr, true, "fields">>>;
