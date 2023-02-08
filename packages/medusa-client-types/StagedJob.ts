/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

/**
 * A staged job resource
 */
export type StagedJob = {
  /**
   * The staged job's ID
   */
  id: string;
  /**
   * The name of the event
   */
  event_name: string;
  /**
   * Data necessary for the job
   */
  data: Record<string, any>;
  /**
   * The staged job's option
   */
  option?: Record<string, any>;
};
