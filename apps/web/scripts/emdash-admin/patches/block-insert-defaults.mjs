// Slash-menu insertion asks `blockEditorExtensions[].insertDefaults` for
// prefilled values. The entry's current form data (`documentData`) is passed
// down from the content editor so a default can follow other fields.

export default {
  id: "block-insert-defaults",
  summary: "Prefills new plugin blocks from trusted plugins (insertDefaults).",
  upstream: "Propose insert defaults for plugin blocks (with access to the entry draft) upstream.",
  apply(editor) {
    editor.within("function PortableTextEditor({ value, onChange,", "\nfunction ", (scope) => {
      scope.replace("pluginBlocks = [], focusMode: controlledFocusMode,", "pluginBlocks = [], documentData, focusMode: controlledFocusMode,");
      scope.replace(
        "\tconst [pluginBlockInitialValues, setPluginBlockInitialValues] = React$1.useState(void 0);\n",
        `\tconst [pluginBlockInitialValues, setPluginBlockInitialValues] = React$1.useState(void 0);
\tconst [pluginBlockDefaultValues, setPluginBlockDefaultValues] = React$1.useState(void 0);
\tconst blockInsertExtensionsRef = React$1.useRef([]);
\tblockInsertExtensionsRef.current = useBlockEditorExtensions();
\tconst documentDataRef = React$1.useRef(documentData);
\tdocumentDataRef.current = documentData;
`,
      );
      scope.replace(
        "\t\t\t\teditor.chain().focus().deleteRange(range).run();\n\t\t\t\tsetPluginBlockModal(block);",
        `\t\t\t\teditor.chain().focus().deleteRange(range).run();
\t\t\t\tconst insertPos = pendingBlockInsertPosRef.current ?? range.from;
\t\t\t\tsetPluginBlockDefaultValues(resolveBlockInsertDefaults(blockInsertExtensionsRef.current, {
\t\t\t\t\tblock,
\t\t\t\t\teditor,
\t\t\t\t\tinsertPos,
\t\t\t\t\tdocumentData: documentDataRef.current
\t\t\t\t}));
\t\t\t\tsetPluginBlockModal(block);`,
      );
      scope.replace(
        "\t\t\teditingBlockPosRef.current = attrs.pos;\n\t\t\tsetPluginBlockInitialValues({",
        "\t\t\teditingBlockPosRef.current = attrs.pos;\n\t\t\tsetPluginBlockDefaultValues(void 0);\n\t\t\tsetPluginBlockInitialValues({",
      );
      scope.replace(
        "\t\tsetPluginBlockInitialValues(void 0);\n\t\teditingBlockPosRef.current = null;\n\t}, [editor, pluginBlockModal]);",
        "\t\tsetPluginBlockInitialValues(void 0);\n\t\tsetPluginBlockDefaultValues(void 0);\n\t\teditingBlockPosRef.current = null;\n\t}, [editor, pluginBlockModal]);",
      );
      scope.replace(
        "\t\t\t\t\t\tinitialValues: pluginBlockInitialValues,\n\t\t\t\t\t\tonClose: () => {\n\t\t\t\t\t\t\tpendingBlockInsertPosRef.current = null;\n\t\t\t\t\t\t\tsetPluginBlockModal(null);\n\t\t\t\t\t\t\tsetPluginBlockInitialValues(void 0);",
        "\t\t\t\t\t\tinitialValues: pluginBlockInitialValues,\n\t\t\t\t\t\tdefaultValues: pluginBlockDefaultValues,\n\t\t\t\t\t\tonClose: () => {\n\t\t\t\t\t\t\tpendingBlockInsertPosRef.current = null;\n\t\t\t\t\t\t\tsetPluginBlockModal(null);\n\t\t\t\t\t\t\tsetPluginBlockInitialValues(void 0);\n\t\t\t\t\t\t\tsetPluginBlockDefaultValues(void 0);",
      );
    });

    editor.within("function FieldRenderer({ name, field, value, onChange,", "\nfunction ", (scope) => {
      scope.replace("onEditorReady, minimal, pluginBlocks, onBlockSidebarOpen,", "onEditorReady, minimal, pluginBlocks, documentData, onBlockSidebarOpen,");
      scope.replace("\t\t\t\t\tpluginBlocks,\n\t\t\t\t\tonEditorReady,\n", "\t\t\t\t\tpluginBlocks,\n\t\t\t\t\tdocumentData,\n\t\t\t\t\tonEditorReady,\n");
    });

    editor.within("function ContentEditor({ collection,", "\nfunction ", (scope) => {
      scope.replace(
        "\t\t\t\t\t\t\t\t\t\t\t\t\tpluginBlocks,\n\t\t\t\t\t\t\t\t\t\t\t\t\tonBlockSidebarOpen: field.kind === \"portableText\" ? handleBlockSidebarOpen : void 0,",
        "\t\t\t\t\t\t\t\t\t\t\t\t\tpluginBlocks,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdocumentData: formData,\n\t\t\t\t\t\t\t\t\t\t\t\t\tonBlockSidebarOpen: field.kind === \"portableText\" ? handleBlockSidebarOpen : void 0,",
      );
    });
  },
};
