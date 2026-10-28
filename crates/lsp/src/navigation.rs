//! Code navigation requests: references, implementation, type definition, declaration,
//! symbols, call and type hierarchy, document highlights, signature help and rename.
//!
//! Every request is gated on the capability the server advertised (`LspError::Unsupported`
//! otherwise), has a `_with_cancel` variant, and goes through the shared request path, so
//! `ContentModified` retries and cancellation behave exactly like definition.

use crate::client::{one_of_enabled, LspClient};
use crate::error::{LspError, Result};
use lsp_types::*;
use tokio_util::sync::CancellationToken;

/// Defines `$name` and `$name_cancel` for one request.
macro_rules! nav_request {
    ($name:ident, $name_cancel:ident, $params:ty, $out:ty, $method:literal, $cap:ident) => {
        pub async fn $name(&self, params: $params) -> Result<Option<$out>> {
            self.nav(self.$cap(), $method, params, None).await
        }

        pub async fn $name_cancel(
            &self,
            params: $params,
            cancel_token: CancellationToken,
        ) -> Result<Option<$out>> {
            self.nav(self.$cap(), $method, params, Some(&cancel_token))
                .await
        }
    };
}

impl LspClient {
    async fn nav<P: serde::Serialize, T: serde::de::DeserializeOwned>(
        &self,
        supported: bool,
        method: &'static str,
        params: P,
        cancel: Option<&CancellationToken>,
    ) -> Result<Option<T>> {
        self.require(supported, method)?;
        let value = serde_json::to_value(params)?;
        self.typed_request(method, value, cancel).await
    }

    pub fn supports_references(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.references_provider))
    }

    pub fn supports_implementation(&self) -> bool {
        self.has_capability(|c| match &c.implementation_provider {
            None | Some(ImplementationProviderCapability::Simple(false)) => false,
            Some(_) => true,
        })
    }

    pub fn supports_type_definition(&self) -> bool {
        self.has_capability(|c| match &c.type_definition_provider {
            None | Some(TypeDefinitionProviderCapability::Simple(false)) => false,
            Some(_) => true,
        })
    }

    pub fn supports_declaration(&self) -> bool {
        self.has_capability(|c| match &c.declaration_provider {
            None | Some(DeclarationCapability::Simple(false)) => false,
            Some(_) => true,
        })
    }

    pub fn supports_document_symbol(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.document_symbol_provider))
    }

    pub fn supports_workspace_symbol(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.workspace_symbol_provider))
    }

    pub fn supports_call_hierarchy(&self) -> bool {
        self.has_capability(|c| match &c.call_hierarchy_provider {
            None | Some(CallHierarchyServerCapability::Simple(false)) => false,
            Some(_) => true,
        })
    }

    pub fn supports_document_highlight(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.document_highlight_provider))
    }

    pub fn supports_signature_help(&self) -> bool {
        self.has_capability(|c| c.signature_help_provider.is_some())
    }

    pub fn supports_rename(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.rename_provider))
    }

    /// Rename with a `prepareRename` step (`renameProvider.prepareProvider`).
    pub fn supports_prepare_rename(&self) -> bool {
        self.has_capability(|c| {
            matches!(
                &c.rename_provider,
                Some(OneOf::Right(RenameOptions {
                    prepare_provider: Some(true),
                    ..
                }))
            )
        })
    }

    nav_request!(
        references,
        references_with_cancel,
        ReferenceParams,
        Vec<Location>,
        "textDocument/references",
        supports_references
    );
    nav_request!(
        implementation,
        implementation_with_cancel,
        GotoDefinitionParams,
        GotoDefinitionResponse,
        "textDocument/implementation",
        supports_implementation
    );
    nav_request!(
        type_definition,
        type_definition_with_cancel,
        GotoDefinitionParams,
        GotoDefinitionResponse,
        "textDocument/typeDefinition",
        supports_type_definition
    );
    nav_request!(
        declaration,
        declaration_with_cancel,
        GotoDefinitionParams,
        GotoDefinitionResponse,
        "textDocument/declaration",
        supports_declaration
    );
    // Hierarchical `DocumentSymbol[]` and flat `SymbolInformation[]` are both accepted.
    nav_request!(
        document_symbols,
        document_symbols_with_cancel,
        DocumentSymbolParams,
        DocumentSymbolResponse,
        "textDocument/documentSymbol",
        supports_document_symbol
    );
    nav_request!(
        workspace_symbols,
        workspace_symbols_with_cancel,
        WorkspaceSymbolParams,
        WorkspaceSymbolResponse,
        "workspace/symbol",
        supports_workspace_symbol
    );
    nav_request!(
        prepare_call_hierarchy,
        prepare_call_hierarchy_with_cancel,
        CallHierarchyPrepareParams,
        Vec<CallHierarchyItem>,
        "textDocument/prepareCallHierarchy",
        supports_call_hierarchy
    );
    nav_request!(
        incoming_calls,
        incoming_calls_with_cancel,
        CallHierarchyIncomingCallsParams,
        Vec<CallHierarchyIncomingCall>,
        "callHierarchy/incomingCalls",
        supports_call_hierarchy
    );
    nav_request!(
        outgoing_calls,
        outgoing_calls_with_cancel,
        CallHierarchyOutgoingCallsParams,
        Vec<CallHierarchyOutgoingCall>,
        "callHierarchy/outgoingCalls",
        supports_call_hierarchy
    );
    nav_request!(
        prepare_type_hierarchy,
        prepare_type_hierarchy_with_cancel,
        TypeHierarchyPrepareParams,
        Vec<TypeHierarchyItem>,
        "textDocument/prepareTypeHierarchy",
        supports_type_hierarchy
    );
    nav_request!(
        type_supertypes,
        type_supertypes_with_cancel,
        TypeHierarchySupertypesParams,
        Vec<TypeHierarchyItem>,
        "typeHierarchy/supertypes",
        supports_type_hierarchy
    );
    nav_request!(
        type_subtypes,
        type_subtypes_with_cancel,
        TypeHierarchySubtypesParams,
        Vec<TypeHierarchyItem>,
        "typeHierarchy/subtypes",
        supports_type_hierarchy
    );
    nav_request!(
        document_highlights,
        document_highlights_with_cancel,
        DocumentHighlightParams,
        Vec<DocumentHighlight>,
        "textDocument/documentHighlight",
        supports_document_highlight
    );
    nav_request!(
        signature_help,
        signature_help_with_cancel,
        SignatureHelpParams,
        SignatureHelp,
        "textDocument/signatureHelp",
        supports_signature_help
    );
    nav_request!(
        prepare_rename,
        prepare_rename_with_cancel,
        TextDocumentPositionParams,
        PrepareRenameResponse,
        "textDocument/prepareRename",
        supports_prepare_rename
    );
    nav_request!(
        rename,
        rename_with_cancel,
        RenameParams,
        WorkspaceEdit,
        "textDocument/rename",
        supports_rename
    );

    /// JDT LS `java/classFileContents`: the source of a `jdt://` class file URI. Only
    /// valid against JDT LS, the caller gates on the server.
    pub async fn class_file_contents(
        &self,
        uri: &str,
        cancel_token: CancellationToken,
    ) -> Result<Option<String>> {
        if !self.is_initialized_with_capabilities() {
            return Err(LspError::Unsupported("java/classFileContents".to_string()));
        }
        let params = serde_json::json!({ "uri": uri });
        self.typed_request::<String>("java/classFileContents", params, Some(&cancel_token))
            .await
    }

    fn is_initialized_with_capabilities(&self) -> bool {
        self.server_capabilities().is_some()
    }
}
