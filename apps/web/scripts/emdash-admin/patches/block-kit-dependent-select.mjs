// Block Kit `select` with `optionsRoute` gains form-aware options:
//   depends_on: ["otherField"]  reload options (POST { values }) when those
//                               fields change; clear this value on change.
//   clear_fields: ["field"]     also clear these fields when a dependency changes.
//   option `values`             patch other form fields when the option is chosen.
// Load failures are shown instead of silently leaving an empty list, and a
// plugin may render an addon under the select (see block-editor-runtime).

export default {
  id: "block-kit-dependent-select",
  summary: "Dependent Block Kit selects (depends_on / clear_fields / option values) and a field addon slot.",
  upstream: "Propose depends_on / clear_fields / option values for Block Kit select upstream.",
  apply(editor) {
    editor.within("function BlockKitField({ field, pluginId, value, onChange }) {", "\nfunction ", (scope) => {
      scope.replace(
        "function BlockKitField({ field, pluginId, value, onChange }) {",
        "function BlockKitField({ field, pluginId, value, onChange, formValues, onPatch = () => {}, renderFieldAddon }) {",
      );
      scope.replace(
        `\t\tcase "select": return /* @__PURE__ */ jsx(DynamicSelect, {
\t\t\tfield,
\t\t\tpluginId,
\t\t\tvalue,
\t\t\tonChange
\t\t});`,
        `\t\tcase "select": return /* @__PURE__ */ jsx(DynamicSelect, {
\t\t\tfield,
\t\t\tpluginId,
\t\t\tvalue,
\t\t\tonChange,
\t\t\tformValues,
\t\t\tonPatch,
\t\t\trenderFieldAddon
\t\t});`,
      );
    });

    editor.within("function DynamicSelect({ field, pluginId, value, onChange }) {", "\nconst WORDS_PER_MINUTE", (scope) => {
      scope.replace(
        "function DynamicSelect({ field, pluginId, value, onChange }) {\n\tconst [dynamicOptions, setDynamicOptions] = React$1.useState(null);\n\tconst [loading, setLoading] = React$1.useState(false);",
        "function DynamicSelect({ field, pluginId, value, onChange, formValues, onPatch = () => {}, renderFieldAddon }) {\n\tconst [dynamicOptions, setDynamicOptions] = React$1.useState(null);\n\tconst [loading, setLoading] = React$1.useState(false);\n\tconst [error, setError] = React$1.useState(\"\");",
      );
      scope.replace(
        "\tReact$1.useEffect(() => {\n\t\tif (!field.optionsRoute || !pluginId) return;\n\t\tconst controller = new AbortController();\n\t\tsetLoading(true);",
        `\tconst dependencyValues = JSON.stringify((field.depends_on ?? []).map((key) => formValues?.[key] ?? null));
\tconst previousDependencies = React$1.useRef(null);
\tReact$1.useEffect(() => {
\t\tif (previousDependencies.current !== null && previousDependencies.current !== dependencyValues) {
\t\t\tonChange(field.action_id, "");
\t\t\tif (Array.isArray(field.clear_fields)) onPatch(Object.fromEntries(field.clear_fields.map((key) => [key, ""])));
\t\t}
\t\tpreviousDependencies.current = dependencyValues;
\t}, [dependencyValues]);
\tReact$1.useEffect(() => {
\t\tif (!field.optionsRoute || !pluginId) return;
\t\tif ((field.depends_on ?? []).some((key) => !formValues?.[key])) {
\t\t\tsetDynamicOptions([]);
\t\t\treturn;
\t\t}
\t\tconst controller = new AbortController();
\t\tsetError("");
\t\tsetLoading(true);`,
      );
      scope.replace("\t\t\t\t\tbody: JSON.stringify({}),", "\t\t\t\t\tbody: JSON.stringify({ values: formValues ?? {} }),");
      scope.replace(
        "\t\t\t\tif (res.ok) {\n\t\t\t\t\tconst body = await res.json();",
        "\t\t\t\tif (!res.ok) throw new Error(`写真を読み込めませんでした（${res.status}）`);\n\t\t\t\tif (res.ok) {\n\t\t\t\t\tconst body = await res.json();",
      );
      scope.replace("\t\t\t\t\t\tlabel: item.name,\n\t\t\t\t\t\tvalue: item.id\n", "\t\t\t\t\t\tlabel: item.name,\n\t\t\t\t\t\tvalue: item.id,\n\t\t\t\t\t\tvalues: item.values\n");
      scope.replace(
        "\t\t\t} catch {} finally {\n\t\t\t\tif (!controller.signal.aborted) setLoading(false);",
        "\t\t\t} catch (cause) {\n\t\t\t\tif (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : \"写真を読み込めませんでした。\");\n\t\t\t} finally {\n\t\t\t\tif (!controller.signal.aborted) setLoading(false);",
      );
      scope.replace("\t}, [field.optionsRoute, pluginId]);", "\t}, [field.optionsRoute, pluginId, dependencyValues]);");
      scope.replace(
        "\tconst options = dynamicOptions ?? field.options;\n",
        `\tconst options = dynamicOptions ?? field.options;
\tconst selectOption = (nextValue) => {
\t\tonChange(field.action_id, nextValue);
\t\tconst selectedOption = options.find((option) => option.value === nextValue);
\t\tif (selectedOption?.values && typeof selectedOption.values === "object") onPatch(selectedOption.values);
\t};
`,
      );
      scope.replace("\t\tonValueChange: (v) => onChange(field.action_id, v ?? \"\"),", "\t\tonValueChange: (v) => selectOption(v ?? \"\"),");
      scope.replace(
        "\t\t\t...Object.fromEntries(options.map((opt) => [opt.value, opt.label]))\n\t\t}\n\t})] });\n}",
        `\t\t\t...Object.fromEntries(options.map((opt) => [opt.value, opt.label]))
\t\t}
\t}), error ? /* @__PURE__ */ jsx("p", {
\t\trole: "alert",
\t\tclassName: "mt-2 text-sm text-kumo-danger",
\t\tchildren: error
\t}) : null, renderFieldAddon ? /* @__PURE__ */ jsx(Fragment, { children: renderFieldAddon({ field, options, value, select: selectOption }) }) : null] });
}`,
      );
    });
  },
};
