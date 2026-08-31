In-page section switch. Underline variant carries a 2px coral rule under the active tab; pill variant sits inside cards and pricing headers.

```jsx
<Tabs items={["Overview","Coverage","Evidence"]} value={tab} onChange={setTab} />
<Tabs variant="pill" items={["Monthly","Annual"]} value={period} onChange={setPeriod} />
```
