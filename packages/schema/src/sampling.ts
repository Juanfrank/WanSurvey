import { z } from 'zod';
import { Disposition } from './disposition.js';

/**
 * The sampling plan of a project (S1), in three layers: where the units come from, how they
 * are selected, and what is checked before selecting. Sizes keep apart the completes the
 * objective needs, the units to select and the cases to field (decision 2).
 */

/** Layer 1: the source of the units. Population size and frame are separate facts (decision 1). */
export const SamplingSource = z.object({
  kind: z.enum(['frame', 'registry', 'field', 'combined']).default('frame'),
  /** What a unit is: people, households, companies… */
  unit: z.string().trim().max(100).default(''),
  description: z.string().max(2000).default(''),
  populationKnown: z.boolean().default(false),
  populationSize: z.number().int().positive().nullable().default(null),
  frameAvailable: z.boolean().default(true),
});
export type SamplingSource = z.infer<typeof SamplingSource>;

export const PROBABILITY_METHODS = [
  'srs',
  'systematic',
  'stratified',
  'cluster',
  'multistage',
] as const;
export const NONPROBABILITY_METHODS = ['quota', 'convenience', 'purposive', 'snowball'] as const;
export const SPECIAL_METHODS = ['adaptive', 'timelocation', 'other'] as const;

/** Layer 2: the selection design. */
export const SamplingDesign = z.object({
  family: z.enum(['census', 'probability', 'nonprobability', 'special']).default('probability'),
  method: z
    .enum(['census', ...PROBABILITY_METHODS, ...NONPROBABILITY_METHODS, ...SPECIAL_METHODS])
    .default('srs'),
  /** Sample fields that give the stratum, the cluster, its size, and the systematic order. */
  strataVar: z.string().max(64).default(''),
  clusterVar: z.string().max(64).default(''),
  sizeVar: z.string().max(64).default(''),
  sortVar: z.string().max(64).default(''),
  allocation: z.enum(['proportional', 'equal', 'manual']).default('proportional'),
  perStratum: z.record(z.string(), z.number().int().min(0)).default({}),
  within: z.enum(['srs', 'systematic']).default('srs'),
  clusters: z.number().int().min(1).default(10),
  pps: z.boolean().default(false),
  /** Units per selected cluster; 0 takes them all. */
  perCluster: z.number().int().min(0).default(0),
  description: z.string().max(2000).default(''),
});
export type SamplingDesign = z.infer<typeof SamplingDesign>;

/** The objective behind the size (decision 3), and the rates that turn it into units. */
export const SamplingSize = z.object({
  objective: z.enum(['proportion', 'mean', 'difference', 'fixed']).default('proportion'),
  confidence: z.number().min(0.5).max(0.999).default(0.95),
  margin: z.number().positive().max(1000).default(0.05),
  p: z.number().min(0.01).max(0.99).default(0.5),
  sd: z.number().positive().default(1),
  p1: z.number().min(0.01).max(0.99).default(0.5),
  p2: z.number().min(0.01).max(0.99).default(0.6),
  power: z.number().min(0.5).max(0.99).default(0.8),
  deff: z.number().min(1).max(20).default(1),
  /** For a fixed size: the completes wanted. */
  fixedN: z.number().int().positive().default(100),
  /** Expected shares: eligible among selected, completing among eligible. */
  eligibility: z.number().min(0.01).max(1).default(1),
  response: z.number().min(0.01).max(1).default(1),
  /** Reserve units, as a share of the selected ones. */
  reserve: z.number().min(0).max(2).default(0),
});
export type SamplingSize = z.infer<typeof SamplingSize>;

/** Quotas as a control dimension (decision 4): cells with a condition and a target. */
export const SamplingQuota = z.object({
  name: z.string().trim().min(1).max(100),
  when: z.string().max(500),
  target: z.number().int().min(0),
});

/** Substitution only by rules set beforehand, recorded on both cases (decision 6). */
export const SamplingSubstitution = z.object({
  allowed: z.boolean().default(false),
  rule: z.enum(['sameStratum', 'nextReserve']).default('sameStratum'),
  /** Final results that allow a substitute. */
  reasons: z.array(z.string()).default(['REFUSAL', 'NON_CONTACT']),
});

/**
 * A cross-case check: a unit is not eligible when the same person (all the listed fields
 * equal: sample fields, or `phone` / `email` from the contacts) had one of these results in
 * the last `withinDays` days, in this project or in any project of the organisation.
 */
export const CrossCheck = z.object({
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(5),
  scope: z.enum(['project', 'organisation']).default('project'),
  withinDays: z.number().int().min(1).max(36_500),
  results: z.array(Disposition).min(1).default(['COMPLETE']),
});
export type CrossCheck = z.infer<typeof CrossCheck>;

export const SamplingPlanInput = z.object({
  source: SamplingSource.default(SamplingSource.parse({})),
  design: SamplingDesign.default(SamplingDesign.parse({})),
  size: SamplingSize.default(SamplingSize.parse({})),
  eligibility: z.string().max(1000).nullable().default(null),
  exclusions: z.string().max(1000).nullable().default(null),
  quotas: z.array(SamplingQuota).max(100).default([]),
  substitution: SamplingSubstitution.default(SamplingSubstitution.parse({})),
  crossChecks: z.array(CrossCheck).max(10).default([]),
});
export type SamplingPlanInput = z.infer<typeof SamplingPlanInput>;
