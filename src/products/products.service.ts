import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) { }

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    return this.productsRepository.save(product);
  }

  async updateStock(id: number, quantity: number): Promise<Product> {
    const product = await this.findOne(id);
    product.stock = quantity;
    return this.productsRepository.save(product);
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
  }

  // 4. The problem is that this method do not use cache and always query the database, which can lead to performance issues if there are many products. Also, the productsRepository.find() method retrieves all products from the database, which can be inefficient if there are a large number of products. Additionally, the filtering is done in memory, which can further degrade performance. 
  // Solution: To improve performance, we can implement caching for search results. We can use the cacheManager to store search results for a specific query and set an expiration time for the cache. This way, if the same query is made again within the cache expiration time, we can return the cached results instead of querying the database again. Additionally, we can optimize the search by using a full-text search index in the database or by implementing pagination to limit the number of products retrieved at once. The other solution to the query performance is to use a more efficient search algorithm or to use a search engine like Elasticsearch to handle product searches, which can provide faster and more relevant results compared to filtering in memory.
  async searchProducts(query: string): Promise<Product[]> {
    const cacheKey = 'product-search';
    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const products = await this.productsRepository.find();
    const results = products.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(query.toLowerCase())
    );

    await this.cacheManager.set(cacheKey, results, 60000);
    return results;
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  // 5. The problem is that this method retrieves a shallow category tree, which may not include all nested subcategories. This can lead to incomplete data being returned to the client. Additionally, if there are many nested categories, this method may result in multiple database queries, which can impact performance.
  // Solution: Implement the findOne with relations['children'] to retrieve the entire category tree in a single query. This way, we can ensure that all nested subcategories are included in the result.
  async getCategoryTree(categoryId: number): Promise<any> {
    const category = await this.findCategory(categoryId);
    return this.buildCategoryTree(category);
  }


  // 6. The problem is the infinite loop that can occur if we start with a Child category and try to build the tree by recursively calling the parent category.and calls the function again. This creates an infinite loop of recursion until the Node.js call stack is exhausted.
  // Solution: we only set what is under not what is above. So we only set the children and not the parent. This way we avoid the infinite loop and we can build the tree correctly.
  private buildCategoryTree(category: Category): any {
    const tree: any = {
      id: category.id,
      name: category.name,
      children: [],
    };

    if (category.parentId) {
      tree.parent = this.buildCategoryTree(category.parent);
    }

    if (category.children && category.children.length > 0) {
      tree.children = category.children.map(child => this.buildCategoryTree(child));
    }

    return tree;
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;

    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
