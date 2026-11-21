module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // Beberapa dependency (otplib -> @scure/@noble, openid-client -> oauth4webapi/jose) hanya menyediakan ESM; Jest (CommonJS) perlu mentransformasinya.
  transform: { '^.+\\.[jt]s$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }] },
  transformIgnorePatterns: ['/node_modules/(?!.*(@scure|@noble|openid-client|oauth4webapi|jose)/)'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
