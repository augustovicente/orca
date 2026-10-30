export function countProofWork() {
  let work = 0,
    mapEntryVisits = 0
  const get = Map.prototype.get,
    set = Map.prototype.set,
    has = Set.prototype.has,
    add = Set.prototype.add,
    iterator = Set.prototype[Symbol.iterator]
  const push = Array.prototype.push,
    arrayIterator = Array.prototype[Symbol.iterator],
    split = String.prototype.split
  const map = Array.prototype.map,
    filter = Array.prototype.filter,
    flatMap = Array.prototype.flatMap
  const stringIterator = String.prototype[Symbol.iterator],
    startsWith = String.prototype.startsWith,
    endsWith = String.prototype.endsWith,
    slice = String.prototype.slice
  const entries = Map.prototype[Symbol.iterator],
    values = Map.prototype.values
  const arraySlice = Array.prototype.slice,
    stringify = JSON.stringify
  const some = Array.prototype.some,
    every = Array.prototype.every,
    find = Array.prototype.find,
    sort = Array.prototype.sort
  const width = (value: unknown): number =>
    typeof value === 'string'
      ? value.length
      : value && typeof value === 'object' && 'ref' in value && typeof value.ref === 'string'
        ? value.ref.length
        : 1
  Map.prototype[Symbol.iterator] = new Proxy(entries, {
    apply(fn, receiver, args) {
      work += receiver.size
      mapEntryVisits += receiver.size
      return Reflect.apply(fn, receiver, args)
    }
  })
  Map.prototype.values = new Proxy(values, {
    apply(fn, receiver, args) {
      work += receiver.size
      return Reflect.apply(fn, receiver, args)
    }
  })
  String.prototype[Symbol.iterator] = new Proxy(stringIterator, {
    apply(fn, receiver, args) {
      work += String(receiver).length
      return Reflect.apply(fn, receiver, args)
    }
  })
  String.prototype.startsWith = new Proxy(startsWith, {
    apply(fn, receiver, args) {
      work += String(args[0]).length
      return Reflect.apply(fn, receiver, args)
    }
  })
  String.prototype.endsWith = new Proxy(endsWith, {
    apply(fn, receiver, args) {
      work += String(args[0]).length
      return Reflect.apply(fn, receiver, args)
    }
  })
  String.prototype.slice = new Proxy(slice, {
    apply(fn, receiver, args) {
      const result = Reflect.apply(fn, receiver, args)
      work += result.length
      return result
    }
  })
  Map.prototype.get = new Proxy(get, {
    apply(fn, receiver, args) {
      work += width(args[0])
      return Reflect.apply(fn, receiver, args)
    }
  })
  Map.prototype.set = new Proxy(set, {
    apply(fn, receiver, args) {
      work += width(args[0])
      return Reflect.apply(fn, receiver, args)
    }
  })
  Set.prototype.has = new Proxy(has, {
    apply(fn, receiver, args) {
      work += width(args[0])
      return Reflect.apply(fn, receiver, args)
    }
  })
  Set.prototype.add = new Proxy(add, {
    apply(fn, receiver, args) {
      work += width(args[0])
      return Reflect.apply(fn, receiver, args)
    }
  })
  Set.prototype[Symbol.iterator] = new Proxy(iterator, {
    apply(fn, receiver, args) {
      work += receiver.size
      return Reflect.apply(fn, receiver, args)
    }
  })
  Array.prototype.slice = new Proxy(arraySlice, {
    apply(fn, receiver, args) {
      const result = Reflect.apply(fn, receiver, args)
      work += result.length
      return result
    }
  })
  JSON.stringify = new Proxy(stringify, {
    apply(fn, receiver, args) {
      const result = Reflect.apply(fn, receiver, args)
      work += result?.length ?? 0
      return result
    }
  })
  Array.prototype.push = new Proxy(push, {
    apply(fn, receiver, args) {
      work += args.length
      return Reflect.apply(fn, receiver, args)
    }
  })
  Array.prototype[Symbol.iterator] = new Proxy(arrayIterator, {
    apply(fn, receiver, args) {
      work += receiver.length
      return Reflect.apply(fn, receiver, args)
    }
  })
  const counted = <T extends (...args: never[]) => unknown>(method: T): T =>
    new Proxy(method, {
      apply(fn, receiver, args) {
        const [callback, thisArg] = args
        const result = Reflect.apply(fn, receiver, [
          (...values: unknown[]) => {
            work += 1
            return Reflect.apply(callback, thisArg, values)
          },
          thisArg
        ])
        work += Array.isArray(result) ? result.length : 0
        return result
      }
    })
  Array.prototype.sort = new Proxy(sort, {
    apply(fn, receiver, args) {
      const compare = args[0]
      return Reflect.apply(fn, receiver, [
        (a: unknown, b: unknown) => {
          work += width(a) + width(b)
          return compare
            ? Reflect.apply(compare, undefined, [a, b])
            : String(a) < String(b)
              ? -1
              : String(a) > String(b)
                ? 1
                : 0
        }
      ])
    }
  })
  Array.prototype.map = counted(map)
  Array.prototype.filter = counted(filter)
  Array.prototype.flatMap = counted(flatMap)
  Array.prototype.some = counted(some)
  Array.prototype.every = counted(every)
  Array.prototype.find = counted(find)
  String.prototype.split = new Proxy(split, {
    apply(fn, receiver, args) {
      work += String(receiver).length
      return Reflect.apply(fn, receiver, args)
    }
  })
  return {
    value: () => work,
    mapEntryVisits: () => mapEntryVisits,
    restore: () => {
      Map.prototype[Symbol.iterator] = entries
      Map.prototype.values = values
      String.prototype[Symbol.iterator] = stringIterator
      String.prototype.startsWith = startsWith
      String.prototype.endsWith = endsWith
      String.prototype.slice = slice
      Map.prototype.get = get
      Map.prototype.set = set
      Set.prototype.has = has
      Set.prototype.add = add
      Set.prototype[Symbol.iterator] = iterator
      Array.prototype.slice = arraySlice
      JSON.stringify = stringify
      Array.prototype.push = push
      Array.prototype[Symbol.iterator] = arrayIterator
      Array.prototype.map = map
      Array.prototype.filter = filter
      Array.prototype.flatMap = flatMap
      Array.prototype.some = some
      Array.prototype.every = every
      Array.prototype.find = find
      Array.prototype.sort = sort
      String.prototype.split = split
    }
  }
}
