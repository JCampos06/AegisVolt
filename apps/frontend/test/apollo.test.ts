import { describe, expect, it } from 'vitest';
import { graphqlUrls } from '../src/apollo';

describe('graphqlUrls', () => {
  it('usa /graphql del mismo host (Ingress del ambiente)', () => {
    expect(graphqlUrls({ protocol: 'http:', host: 'test.aegisvolt.localhost:8080' }, undefined)).toEqual({
      http: 'http://test.aegisvolt.localhost:8080/graphql',
      ws: 'ws://test.aegisvolt.localhost:8080/graphql',
    });
  });

  it('con https usa wss', () => {
    expect(graphqlUrls({ protocol: 'https:', host: 'aegisvolt.example' }, undefined).ws).toBe('wss://aegisvolt.example/graphql');
  });

  it('respeta VITE_GRAPHQL_URL si se define', () => {
    expect(graphqlUrls({ protocol: 'http:', host: 'localhost:5173' }, 'http://localhost:4000/graphql').ws).toBe('ws://localhost:4000/graphql');
  });
});
