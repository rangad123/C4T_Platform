Label + hint/error wrapper for any form control. Always wrap inputs in it — never use a bare placeholder as a label.

```jsx
<Field label="Work email" required htmlFor="email" error={err}>
  <Input id="email" type="email" invalid={!!err} />
</Field>
```
