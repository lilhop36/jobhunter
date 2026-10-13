/**
 * What caused a collection run to start. Engineering-owned; must match the
 * SourceRunTrigger enum in prisma/schema.prisma.
 */
export enum SourceRunTrigger {
  SCHEDULE = 'SCHEDULE',
  MANUAL = 'MANUAL',
  STARTUP = 'STARTUP',
}
