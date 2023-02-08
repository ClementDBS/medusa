/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

/**
 * Address fields used when creating/updating an address.
 */
export type AddressFields = {
  /**
   * Company name
   */
  company?: string;
  /**
   * First name
   */
  first_name?: string;
  /**
   * Last name
   */
  last_name?: string;
  /**
   * Address line 1
   */
  address_1?: string;
  /**
   * Address line 2
   */
  address_2?: string;
  /**
   * City
   */
  city?: string;
  /**
   * The 2 character ISO code of the country in lower case
   */
  country_code?: string;
  /**
   * Province
   */
  province?: string;
  /**
   * Postal Code
   */
  postal_code?: string;
  /**
   * Phone Number
   */
  phone?: string;
  /**
   * An optional key-value map with additional details
   */
  metadata?: Record<string, any>;
};
