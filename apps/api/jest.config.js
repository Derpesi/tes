module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // Beberapa dependency (otplib -> @scure/@noble, openid-client -> oauth4webapi/jose) hanya menyediakan ESM; Jest (CommonJS) perlu mentransformasinya.
  transform: { '^.+\\.[jt]s$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }] },
  transformIgnorePatterns: ['/node_modules/(?!.*(@scure|@noble|openid-client|oauth4webapi|jose)/)'],
  // Runner CI lebih lambat (argon2 + login banyak peran pada beforeAll); batas bawaan 5 detik terlalu ketat dan membuat tes rapuh.
  testTimeout: 60000,
  moduleFileExtensions: ['ts', 'js', 'json'],
};
