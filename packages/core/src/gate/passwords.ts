// Moved (docs/k-a-plan.md K-a4): the scrypt hashing is the kernel's (../security.ts), and
// which passwords are allowed is people's (@panel/people/gate/passwords, with
// common-passwords.txt beside it). The hashing's names stay here until K-a7 drops this file.
export { hashPassword, verifyPassword } from '../security.ts';
