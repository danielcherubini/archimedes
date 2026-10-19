declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type RequestId = Brand<string, "RequestId">;

export const asSessionId = (id: string): SessionId => id as SessionId;
export const asRequestId = (id: string): RequestId => id as RequestId;
