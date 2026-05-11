'use client'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Country, COUNTRIES } from '@/types'

interface CountryFilterProps {
  selected: Country
  onChange: (country: Country) => void
}

export default function CountryFilter({ selected, onChange }: CountryFilterProps) {
  return (
    <Tabs value={selected} onValueChange={(v) => onChange(v as Country)}>
      <TabsList className="grid w-full max-w-xs grid-cols-3">
        {COUNTRIES.map((country) => (
          <TabsTrigger key={country.code} value={country.code} className="flex items-center gap-2">
            <span>{country.flag}</span>
            <span>{country.name}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
