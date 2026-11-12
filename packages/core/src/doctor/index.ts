import { authzDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { authzDoctorChecks } from './checks.js';

/** The authz doctor checks, read by `agora:doctor --no-boot`. */
export const agoraDoctorChecks = authzDoctorChecks();
