import * as ts from 'typescript';

import { ReflectionKind, ReflectionFlag, ContainerReflection, DeclarationReflection, ProjectReflection } from '../../models/index';
import { Context } from '../context';
import { Converter, SourceFileMode } from '../converter';
import { createReferenceType } from './reference';

/**
 * List of reflection kinds that never should be static.
 */
const nonStaticKinds = [
    ReflectionKind.Class,
    ReflectionKind.Interface,
    ReflectionKind.Module
];

/**
 * List of reflection kinds for whom the exported flag of the container reflection should be considered.
 */
const considerInheritedExportKinds = [
    ReflectionKind.Accessor,
    ReflectionKind.Constructor,
    ReflectionKind.ConstructorSignature,
    ReflectionKind.EnumMember,
    ReflectionKind.Event,
    ReflectionKind.GetSignature,
    ReflectionKind.IndexSignature,
    ReflectionKind.Method,
    ReflectionKind.Parameter,
    ReflectionKind.Property,
    ReflectionKind.SetSignature,
    ReflectionKind.TypeParameter
];

/**
 * Create a declaration reflection from the given TypeScript node.
 *
 * @param context  The context object describing the current state the converter is in. The
 *   scope of the context will be the parent of the generated reflection.
 * @param node  The TypeScript node that should be converted to a reflection.
 * @param kind  The desired kind of the reflection.
 * @param name  The desired name of the reflection.
 * @returns The resulting reflection.
 */
export function createDeclaration(context: Context, node: ts.Node, kind: ReflectionKind, name?: string): DeclarationReflection {
    const container = <ContainerReflection> context.scope;
    if (!(container instanceof ContainerReflection)) {
        throw new Error('Expected container reflection.');
    }

    // Ensure we have a name for the reflection
    if (!name) {
        if (node.localSymbol) {
            name = node.localSymbol.name;
        } else if (node.symbol) {
            name = node.symbol.name;
        } else {
            return null;
        }
    }

    const modifiers = ts.getCombinedModifierFlags(node);

    // Test whether the node is exported
    let isExported: boolean;
    if (container.kindOf([ReflectionKind.Module, ReflectionKind.ExternalModule])
        || ((considerInheritedExportKinds.indexOf(kind) === -1
            || node.kind === ts.SyntaxKind.VariableDeclaration || node.kind === ts.SyntaxKind.FunctionDeclaration)
        && !container.kindOf([ReflectionKind.ObjectLiteral, ReflectionKind.TypeLiteral]))) {
        // Don't inherit exported state
        // - in modules and namespaces
        // - for any kind that is not member of a class/interface etc. like variables or functions
        //   unless they are part of an object or type literal
        //   (check the node.kind since variables or functions in merged namespaces are treated as static properties/methods)
        isExported = false;
    } else {
        isExported = container.flags.isExported;
    }

    if (kind === ReflectionKind.ExternalModule || context.isDeclaration || !!(modifiers & ts.ModifierFlags.Ambient)
        || (container instanceof ProjectReflection && !context.isDeclaration && context.converter.mode === SourceFileMode.File)) {
        isExported = true; // Always mark external modules or declared types as exported
    } else if (node.parent && node.parent.kind === ts.SyntaxKind.VariableDeclarationList) {
        const parentModifiers = ts.getCombinedModifierFlags(node.parent.parent);
        isExported = isExported || !!(parentModifiers & ts.ModifierFlags.Export);
    } else {
        isExported = isExported || !!(modifiers & ts.ModifierFlags.Export);
    }

    if (!isExported && context.converter.excludeNotExported) {
        return null;
    }

    // Test whether the node is private, when inheriting ignore private members
    const isPrivate = !!(modifiers & ts.ModifierFlags.Private);
    if (context.isInherit && isPrivate) {
        return null;
    }

    // Test whether the node is static, when merging a module to a class make the node static
    let isConstructorProperty = false;
    let isStatic = false;
    if (nonStaticKinds.indexOf(kind) === -1) {
        isStatic = !!(modifiers & ts.ModifierFlags.Static);
        if (container.kind === ReflectionKind.Class) {
            if (node.parent && node.parent.kind === ts.SyntaxKind.Constructor) {
                isConstructorProperty = true;
            } else if (!node.parent || node.parent.kind !== ts.SyntaxKind.ClassDeclaration) {
                isStatic = true;
            }
        }
    }

    // Check if we already have a child with the same name and static flag
    let child: DeclarationReflection;
    const children = container.children = container.children || [];
    children.forEach((n: DeclarationReflection) => {
        if (n.name === name && n.flags.isStatic === isStatic) {
            child = n;
        }
    });

    if (!child) {
        // Child does not exist, create a new reflection
        child = new DeclarationReflection(container, name, kind);
        child.setFlag(ReflectionFlag.Static, isStatic);
        child.setFlag(ReflectionFlag.Private, isPrivate);
        child.setFlag(ReflectionFlag.ConstructorProperty, isConstructorProperty);
        child.setFlag(ReflectionFlag.Exported,  isExported);
        child = setupDeclaration(context, child, node);

        if (child) {
            children.push(child);
            context.registerReflection(child, node);
        }
    } else {
        // Merge the existent reflection with the given node
        child = mergeDeclarations(context, child, node, kind);
    }

    // If we have a reflection, trigger the corresponding event
    if (child) {
        context.trigger(Converter.EVENT_CREATE_DECLARATION, child, node);
    }

    return child;
}

/**
 * Setup a newly created declaration reflection.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param reflection  The newly created blank reflection.
 * @param node  The TypeScript node whose properties should be applies to the given reflection.
 * @returns The reflection populated with the values of the given node.
 */
function setupDeclaration(context: Context, reflection: DeclarationReflection, node: ts.Node) {
    const modifiers = ts.getCombinedModifierFlags(node);

    reflection.setFlag(ReflectionFlag.External,  context.isExternal);
    reflection.setFlag(ReflectionFlag.Protected, !!(modifiers & ts.ModifierFlags.Protected));
    reflection.setFlag(ReflectionFlag.Public,    !!(modifiers & ts.ModifierFlags.Public));
    reflection.setFlag(ReflectionFlag.Optional,  !!(node['questionToken']));
    reflection.setFlag(ReflectionFlag.Abstract,  !!(modifiers & ts.ModifierFlags.Abstract));
    reflection.setFlag(ReflectionFlag.Readonly,  !!(modifiers & ts.ModifierFlags.Readonly));
    reflection.setFlag(ReflectionFlag.Ambient,   !!(modifiers & ts.ModifierFlags.Ambient));

    if (
        context.isInherit &&
        (node.parent === context.inheritParent || reflection.flags.isConstructorProperty)
    ) {
        if (!reflection.inheritedFrom) {
            reflection.inheritedFrom = createReferenceType(context, node.symbol, true);
            reflection.getAllSignatures().forEach((signature) => {
                signature.inheritedFrom = createReferenceType(context, node.symbol, true);
            });
        }
    }

    return reflection;
}

/**
 * Merge the properties of the given TypeScript node with the pre existent reflection.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param reflection  The pre existent reflection.
 * @param node  The TypeScript node whose properties should be merged with the given reflection.
 * @param kind  The desired kind of the reflection.
 * @returns The reflection merged with the values of the given node or NULL if the merge is invalid.
 */
function mergeDeclarations(context: Context, reflection: DeclarationReflection, node: ts.Node, kind: ReflectionKind) {
    if (reflection.kind !== kind) {
        const weights = [ReflectionKind.Module, ReflectionKind.Enum, ReflectionKind.Class];
        const kindWeight = weights.indexOf(kind);
        const childKindWeight = weights.indexOf(reflection.kind);
        if (kindWeight > childKindWeight) {
            reflection.kind = kind;
        }
    }

    if (
        context.isInherit &&
        context.inherited.indexOf(reflection.name) !== -1 &&
        (node.parent === context.inheritParent || reflection.flags.isConstructorProperty)
    ) {
        if (!reflection.overwrites) {
            reflection.overwrites = createReferenceType(context, node.symbol, true);
            reflection.getAllSignatures().forEach((signature) => {
                signature.overwrites = createReferenceType(context, node.symbol, true);
            });
        }
        return null;
    }

    return reflection;
}
