/**
 * Compile-time-only public-contract mirror for DSH rc.2's out-of-tree Typert
 * generator recognition bug. Runtime imports still resolve to the pinned
 * @deepseek-ai/dsh-typert-protocol package. ADR-0002 owns this seam.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  import { Context, Service } from '@deepseek-ai/cordis'

  const LOOKUP_HOST: unique symbol
  const LOOKUP_WIRE: unique symbol
  const CONTEXT_WIRE: unique symbol

  export interface TypertLookup<Host, Wire> {
    readonly [LOOKUP_HOST]: Host
    readonly [LOOKUP_WIRE]: Wire
  }

  export interface TypertContext<Wire> {
    readonly [CONTEXT_WIRE]: Wire
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}

  export interface TypertGatewayBinding<ServiceType extends object> {
    readonly service: ServiceType
    readonly serviceKey: string
    readonly namespace: string
  }

  export interface TypertGatewayBindingOptions {
    readonly namespace?: string
  }

  export abstract class TypertRemoteService<out T = never> extends Service<T> {
    readonly typertRemote: TypertGatewayBinding<this>
    protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)
  }

  type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  export function Remote(exportName: string): RemoteMethodDecorator
}
