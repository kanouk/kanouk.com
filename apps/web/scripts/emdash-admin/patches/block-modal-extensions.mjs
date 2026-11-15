// Plugin block dialog extension point: `blockEditorExtensions[].useModal`
// contributes previews (before/after the fields), field transforms, a submit
// gate and select addons, and receives `defaultValues` for new blocks.

export default {
  id: "block-modal-extensions",
  summary: "Lets trusted plugins extend the plugin block insert/edit dialog.",
  upstream: "Propose a trusted-plugin hook for the plugin block dialog upstream.",
  apply(editor) {
    editor.within("function PluginBlockModal({ block, initialValues, onClose, onInsert }) {", "\nfunction BlockKitField(", (scope) => {
      scope.replace(
        "function PluginBlockModal({ block, initialValues, onClose, onInsert }) {",
        "function PluginBlockModal({ block, initialValues, defaultValues, onClose, onInsert }) {",
      );
      // Contributions are read from a ref inside the reset effect so that the
      // plugin hooks' own effects stay ordered after it (as declared below).
      scope.replace(
        "\tReact$1.useEffect(() => {\n\t\tif (block) {\n\t\t\tsetFormValues(buildPluginBlockFormValues(block, initialValues));",
        "\tconst blockModalContributionsRef = React$1.useRef([]);\n\tReact$1.useEffect(() => {\n\t\tif (block) {\n\t\t\tconst nextValues = buildPluginBlockFormValues(block, initialValues ?? defaultValues);\n\t\t\tsetFormValues(nextValues);\n\t\t\tfor (const contribution of blockModalContributionsRef.current) contribution.onOpen?.(nextValues);",
      );
      scope.replace(
        "\t}, [block, initialValues]);\n\tconst problems = pluginBlockProblems(block, formValues);",
        `\t}, [block, initialValues, defaultValues]);
\tconst blockEditorExtensions = useBlockEditorExtensions();
\tconst blockModalContributions = blockEditorExtensions.map((extension) => extension.useModal ? extension.useModal({
\t\tblock,
\t\tformValues,
\t\tsetFormValues,
\t\tinitialValues,
\t\tdefaultValues,
\t\tui: { Button, Input }
\t}) : null).filter(Boolean);
\tblockModalContributionsRef.current = blockModalContributions;
\tconst extensionSubmitVotes = blockModalContributions.map((contribution) => contribution.canSubmit).filter((vote) => vote !== void 0);
\tconst extensionAllowsSubmit = extensionSubmitVotes.every(Boolean);
\tconst renderBlockFieldAddon = (props) => blockModalContributions.map((contribution, index) => contribution.fieldAddon ? /* @__PURE__ */ jsx(Fragment, { children: contribution.fieldAddon(props) }, index) : null);
\tconst transformBlockField = (field) => blockModalContributions.reduce((next, contribution) => contribution.transformField ? contribution.transformField(next) : next, field);
\tconst problems = pluginBlockProblems(block, formValues);`,
      );
      scope.replace(
        "\t\te.stopPropagation();\n\t\tconst form = e.currentTarget;",
        "\t\te.stopPropagation();\n\t\tif (!extensionAllowsSubmit) return;\n\t\tconst form = e.currentTarget;",
      );
      scope.replace(
        "\t\t\t[actionId]: value\n\t\t}));\n\t};\n",
        "\t\t\t[actionId]: value\n\t\t}));\n\t};\n\tconst handleFormPatch = (values) => {\n\t\tsetFormValues((prev) => ({ ...prev, ...values }));\n\t};\n",
      );
      scope.replace(
        "\t\t\t\t\t\ttype: \"submit\",\n\t\t\t\t\t\tform: formId,",
        "\t\t\t\t\t\ttype: \"submit\",\n\t\t\t\t\t\tform: formId,\n\t\t\t\t\t\tdisabled: !extensionAllowsSubmit,",
      );
      scope.replace(
        `children: [/* @__PURE__ */ jsx("div", {
\t\t\t\t\t\tclassName: "grid gap-5",
\t\t\t\t\t\t"data-field-invalid": formError ? true : void 0,
\t\t\t\t\t\tchildren: hasFields ? block.fields.map((field) => {`,
        `children: [/* @__PURE__ */ jsxs("div", {
\t\t\t\t\t\tclassName: "grid gap-5",
\t\t\t\t\t\t"data-field-invalid": formError ? true : void 0,
\t\t\t\t\t\tchildren: [...blockModalContributions.map((contribution, index) => contribution.before ? /* @__PURE__ */ jsx(Fragment, { children: contribution.before }, \`before:\${index}\`) : null), hasFields ? block.fields.map((field) => {`,
      );
      scope.replace(
        `children: [/* @__PURE__ */ jsx(BlockKitField, {
\t\t\t\t\t\t\t\t\tfield,
\t\t\t\t\t\t\t\t\tpluginId: block.pluginId,
\t\t\t\t\t\t\t\t\tvalue: formValues[field.action_id],
\t\t\t\t\t\t\t\t\tonChange: handleFieldChange,
\t\t\t\t\t\t\t\t\terrorId
\t\t\t\t\t\t\t\t}),`,
        `children: [/* @__PURE__ */ jsx(BlockKitField, {
\t\t\t\t\t\t\t\t\tfield: transformBlockField(field),
\t\t\t\t\t\t\t\t\tpluginId: block.pluginId,
\t\t\t\t\t\t\t\t\tvalue: formValues[field.action_id],
\t\t\t\t\t\t\t\t\tformValues,
\t\t\t\t\t\t\t\t\tonPatch: handleFormPatch,
\t\t\t\t\t\t\t\t\trenderFieldAddon: renderBlockFieldAddon,
\t\t\t\t\t\t\t\t\tonChange: handleFieldChange,
\t\t\t\t\t\t\t\t\terrorId
\t\t\t\t\t\t\t\t}),`,
      );
      scope.replace(
        "\t\t\t\t\t\t\t\"aria-invalid\": urlError ? true : void 0\n\t\t\t\t\t\t})\n\t\t\t\t\t}), /* @__PURE__ */ jsx(DialogError, {",
        "\t\t\t\t\t\t\t\"aria-invalid\": urlError ? true : void 0\n\t\t\t\t\t\t}), ...blockModalContributions.map((contribution, index) => contribution.after ? /* @__PURE__ */ jsx(Fragment, { children: contribution.after }, `after:${index}`) : null)]\n\t\t\t\t\t}), /* @__PURE__ */ jsx(DialogError, {",
      );
    });
  },
};
