import { Schema } from "effect";

export type PreviewMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
export type PreviewValue = Schema.MutableJson;
export const previewObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
export type PreviewObject = Schema.MutableJsonObject;

export interface PreviewResponse {
  status: number;
  body?: PreviewValue;
}

export interface PreviewOperation {
  operationId: string;
  method: PreviewMethod;
  /** Same-origin path, with OpenAPI path parameters preserved until handler registration. */
  path: string;
  success: PreviewResponse;
  errors: PreviewResponse[];
  responses: PreviewResponse[];
  /** Successful data was compiled from seed.sql; its timestamps must not be shifted as catalog examples. */
  seeded?: true;
}

export interface PreviewContract {
  operations: PreviewOperation[];
  routes: string[];
  /** Canonical synthetic examples, not production records or credentials. */
  fixtures: PreviewObject;
  /** Sanitized public records compiled from the real development seed; no credential tables or SQL runtime. */
  seedFixtures: PreviewObject;
}
