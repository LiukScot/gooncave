import { randomBytes } from 'crypto';

/**
 * Each test seeds its own throwaway user so specs can run in parallel without
 * stepping on each other's session state.
 */
export const newUser = () => {
  const suffix = randomBytes(4).toString('hex');
  return {
    username: `e2e_${suffix}`,
    password: 'e2e_test_password_123'
  };
};
