# waldur-js-client
JavaScript client for Waldur MasterMind generated from OpenAPI schema

## Example usage

```js
import { client, usersList } from 'waldur-js-client';
import Qs from 'qs';

const querySerializer = (params) =>
    Qs.stringify(params, { arrayFormat: 'repeat' });

client.setConfig({
    auth: () => (API_TOKEN ? 'Token ' + API_TOKEN : undefined),
    baseUrl: API_URL,
    throwOnError: true,
    querySerializer,
});

usersList().then(response => {
    console.log(response.data)
})
```