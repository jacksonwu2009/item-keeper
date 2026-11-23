// 只用来在 macOS 上给 LabelOcrModule.swift 做类型检查的「桩」ExpoModulesCore：
// 这台机器没有 Xcode / iOS SDK，编不了真的 ExpoModulesCore。这里照抄 expo-modules-core 58.1.0
// （node_modules/expo-modules-core/ios）里本模块用到的那些公开声明的签名，函数体都是空的。
// 能查出参数标签、类型、重载选择、闭包写法这类错误；查不出真实框架里的行为问题。
// 签名出处：Core/Arguments/AnyArgument.swift、Core/Records/{Record,Field}.swift、Core/Exceptions/Exception.swift、
// Core/Promise.swift、Core/Modules/Module.swift、Core/Protocols/AnyModule.swift、Core/Modules/ModuleDefinitionBuilder.swift、
// Api/Factories/{ModuleFactories,AsyncFunctionFactories,ConcurrentFunctionFactories,EventListenersFactories}.swift
// （真实声明里的 ~Copyable、sending 这些 Swift 6 写法这台机器的 Swift 5.10 不认，去掉了）
import Foundation

public protocol AnyArgument {}
extension Bool: AnyArgument {}
extension Int: AnyArgument {}
extension Double: AnyArgument {}
extension String: AnyArgument {}
extension Optional: AnyArgument where Wrapped: AnyArgument {}
extension Dictionary: AnyArgument where Key: Hashable {}
extension Array: AnyArgument {}

public protocol Convertible: AnyArgument {}
public protocol Record: Convertible {
  init()
}

@propertyWrapper
public final class Field<Type: AnyArgument> {
  public var wrappedValue: Type
  public init(wrappedValue: Type) { self.wrappedValue = wrappedValue }
  public init(wrappedValue: Type = nil) where Type: ExpressibleByNilLiteral { self.wrappedValue = wrappedValue }
}

open class Exception: Error {
  public init(file: String = #fileID, line: UInt = #line, function: String = #function) {}
  public init(name: String, description: String, code: String? = nil, file: String = #fileID, line: UInt = #line,
              function: String = #function) {}
}

public struct Promise: AnyArgument, Sendable {
  public func resolve(_ value: Any? = nil) {}
  public func resolve<T: AnyArgument>(_ value: T) {}
  public func reject(_ error: Error) {}
  public func reject(_ error: Exception) {}
  public func reject(_ code: String, _ description: String) {}
}

public final class AppContext {}

open class BaseModule {
  public private(set) weak var appContext: AppContext?
  @available(*, unavailable, message: "Module's initializer cannot be overridden")
  public init() {}
  required public init(appContext: AppContext) { self.appContext = appContext }
}

public protocol AnyDefinition {}
public final class ModuleDefinition {
  init(definitions: [AnyDefinition]) {}
}

@resultBuilder
public struct ModuleDefinitionBuilder {
  public static func buildBlock(_ definitions: AnyDefinition...) -> ModuleDefinition {
    ModuleDefinition(definitions: definitions)
  }
}

public protocol AnyModule: AnyObject, AnyArgument {
  init(appContext: AppContext)
  @ModuleDefinitionBuilder
  func definition() -> ModuleDefinition
}
public typealias Module = AnyModule & BaseModule

struct PlainDefinition: AnyDefinition {}
public func Name(_ name: String) -> AnyDefinition { PlainDefinition() }
public func OnDestroy(@_implicitSelfCapture _ closure: @escaping () -> Void) -> AnyDefinition { PlainDefinition() }

public final class AsyncFunctionDefinition<Args, FirstArgType, ReturnType>: AnyDefinition {
  public func runOnQueue(_ queue: DispatchQueue?) -> Self { self }
}
public final class ConcurrentFunctionDefinition<Args, FirstArgType, ReturnType>: AnyDefinition {}

public func AsyncFunction<R>(
  _ name: String, @_implicitSelfCapture _ closure: @escaping () throws -> R
) -> AsyncFunctionDefinition<(), Void, R> { AsyncFunctionDefinition() }

public func AsyncFunction<R, A0: AnyArgument, each A: AnyArgument>(
  _ name: String, @_implicitSelfCapture _ closure: @escaping (A0, repeat each A) throws -> R
) -> AsyncFunctionDefinition<(A0, repeat each A), A0, R> { AsyncFunctionDefinition() }

public func AsyncFunction<R>(
  _ name: String,
  @_inheritActorContext @_implicitSelfCapture _ closure: @escaping @Sendable () async throws -> R
) -> ConcurrentFunctionDefinition<(), Void, R> { ConcurrentFunctionDefinition() }

public func AsyncFunction<R, A0: AnyArgument, each A: AnyArgument>(
  _ name: String,
  @_inheritActorContext @_implicitSelfCapture _ closure: @escaping @Sendable (A0, repeat each A) async throws -> R
) -> ConcurrentFunctionDefinition<(A0, repeat each A), A0, R> { ConcurrentFunctionDefinition() }
